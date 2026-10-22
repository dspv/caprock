package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strconv"

	"github.com/dspv/caprock/internal/event"
)

// toolFields is what a tool call's readers need from its payload, read once
// when the call is written (migration 0070, tool_fields): the Tools screen's
// group for a tool.pre, and for a tool.post whether it failed and, on an
// Agent/Task result, the subagent it names.
type toolFields struct {
	drillKey, drillBy string
	isError           bool
	agentID           string
	agentDesc         string
}

// toolFieldsVersion names how drill_key is derived. Raising it re-derives
// every stored call on the next Open, so a change to drillKey reaches the
// calls stored before it.
const toolFieldsVersion = "1"

// metaToolFields is the toolFieldsVersion every stored tool.pre carries.
const metaToolFields = "tool_fields_version"

// readToolFields reads a tool event's fields from its payload. ok is false
// for an event with nothing to store: not a tool call, or a result that
// neither failed nor names a subagent.
func readToolFields(kind event.Kind, tool string, payload []byte) (toolFields, bool) {
	switch kind {
	case event.KindToolPre:
		key, by := drillKeyOf(tool, payload)
		return toolFields{drillKey: key, drillBy: by}, true
	case event.KindToolPost:
		var p struct {
			IsError      json.RawMessage `json:"is_error"`
			ToolResponse json.RawMessage `json:"tool_response"`
		}
		if json.Unmarshal(payload, &p) != nil {
			return toolFields{}, false
		}
		f := toolFields{isError: truthy(p.IsError)}
		if tool == "Agent" || tool == "Task" {
			var r map[string]json.RawMessage
			if json.Unmarshal(p.ToolResponse, &r) == nil {
				f.agentID, f.agentDesc = jsonText(r["agentId"]), jsonText(r["description"])
			}
		}
		return f, f.isError || f.agentID != ""
	}
	return toolFields{}, false
}

// drillKeyOf is drillKey over a tool.pre's payload, the same fields
// ToolDrillStats once extracted with json_extract on every read. The home
// directory is left unshortened: it is a property of the reader, applied
// when the Tools screen asks (homeRel).
func drillKeyOf(tool string, payload []byte) (string, string) {
	var p struct {
		Cwd       json.RawMessage `json:"cwd"`
		ToolInput json.RawMessage `json:"tool_input"`
	}
	_ = json.Unmarshal(payload, &p)
	var in map[string]json.RawMessage
	raw := ""
	if s, ok := jsonString(p.ToolInput); ok {
		// Codex's exec tool records its script as a bare string.
		raw = s
	} else {
		_ = json.Unmarshal(p.ToolInput, &in)
	}
	first := func(names ...string) string {
		for _, n := range names {
			if v, ok := in[n]; ok && !isJSONNull(v) {
				return jsonText(v)
			}
		}
		return ""
	}
	return drillKey(drillKind(tool), jsonText(p.Cwd),
		first("command"), first("file_path", "notebook_path"), first("url"), first("query"),
		first("action", "tool_name", "name"), first("pattern"), first("subagent_type"), raw, "")
}

// jsonText is a JSON value as json_extract hands it to a TEXT scan: a string
// unquoted, null or nothing as "", anything else as its JSON text.
func jsonText(v json.RawMessage) string {
	if s, ok := jsonString(v); ok {
		return s
	}
	if isJSONNull(v) {
		return ""
	}
	return string(v)
}

func jsonString(v json.RawMessage) (string, bool) {
	if len(v) == 0 || v[0] != '"' {
		return "", false
	}
	var s string
	if json.Unmarshal(v, &s) != nil {
		return "", false
	}
	return s, true
}

func isJSONNull(v json.RawMessage) bool { return len(v) == 0 || string(v) == "null" }

// truthy is a JSON value as SQLite reads `value <> 0`: true, a non-zero
// number, or any string.
func truthy(v json.RawMessage) bool {
	switch {
	case isJSONNull(v), string(v) == "false":
		return false
	case string(v) == "true", v[0] == '"':
		return true
	}
	n, err := strconv.ParseFloat(string(v), 64)
	return err == nil && n != 0
}

// putToolFields stores a tool event's fields, replacing what it had.
func putToolFields(ctx context.Context, q Querier, id int64, f toolFields) error {
	_, err := q.ExecContext(ctx, `
		INSERT INTO tool_fields(event_id, drill_key, drill_by, is_error, agent_id, agent_desc)
		VALUES(?, ?, ?, ?, ?, ?)
		ON CONFLICT(event_id) DO UPDATE SET drill_key = excluded.drill_key, drill_by = excluded.drill_by,
		  is_error = excluded.is_error, agent_id = excluded.agent_id, agent_desc = excluded.agent_desc`,
		id, nullStr(f.drillKey), nullStr(f.drillBy), nullTrue(f.isError), nullStr(f.agentID), nullStr(f.agentDesc))
	return err
}

func nullTrue(b bool) any {
	if b {
		return 1
	}
	return nil
}

// RefreshToolFields re-reads one event's fields after its payload was
// rewritten in place (a Codex call whose input was repaired).
func RefreshToolFields(ctx context.Context, q Querier, id int64) error {
	var kind, tool string
	var payload []byte
	err := q.QueryRowContext(ctx, `SELECT kind, COALESCE(tool, ''), payload FROM events WHERE id = ?`, id).
		Scan(&kind, &tool, &payload)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	f, ok := readToolFields(event.Kind(kind), tool, payload)
	if !ok {
		_, err = q.ExecContext(ctx, `DELETE FROM tool_fields WHERE event_id = ?`, id)
		return err
	}
	return putToolFields(ctx, q, id, f)
}

// backfillToolFields derives drill_key for tool calls stored before
// migration 0070, or before toolFieldsVersion last changed. The results were
// filled by the migration itself; a call needs drillKey, which is Go.
//
// A call without a key is one not yet read, so an interrupted pass resumes by
// itself; the marker keeps a finished pass off every later open.
func (s *Store) backfillToolFields(ctx context.Context) error {
	done, err := s.GetMeta(ctx, metaToolFields)
	if err == nil && done == toolFieldsVersion {
		return nil
	}
	if done != "" {
		if _, err := s.db.ExecContext(ctx, `UPDATE tool_fields SET drill_key = NULL, drill_by = NULL`); err != nil {
			return err
		}
	}
	const batch = 5000
	var lastID int64
	for {
		rows, err := s.db.QueryContext(ctx, `
			SELECT e.id, COALESCE(e.tool, ''), e.payload FROM events e
			  LEFT JOIN tool_fields f ON f.event_id = e.id
			 WHERE e.kind = 'tool.pre' AND e.id > ? AND f.drill_key IS NULL
			 ORDER BY e.id LIMIT ?`, lastID, batch)
		if err != nil {
			return err
		}
		type row struct {
			id int64
			f  toolFields
		}
		var pending []row
		for rows.Next() {
			var id int64
			var tool string
			var payload []byte
			if err := rows.Scan(&id, &tool, &payload); err != nil {
				_ = rows.Close()
				return err
			}
			f, _ := readToolFields(event.KindToolPre, tool, payload)
			pending = append(pending, row{id, f})
			lastID = id
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			return err
		}
		if err := rows.Close(); err != nil {
			return err
		}
		if len(pending) == 0 {
			break
		}
		err = s.WithTx(ctx, func(q Querier) error {
			for _, r := range pending {
				if _, err := q.ExecContext(ctx, `
					INSERT INTO tool_fields(event_id, drill_key, drill_by) VALUES(?, ?, ?)
					ON CONFLICT(event_id) DO UPDATE SET drill_key = excluded.drill_key, drill_by = excluded.drill_by`,
					r.id, r.f.drillKey, r.f.drillBy); err != nil {
					return err
				}
			}
			return nil
		})
		if err != nil {
			return err
		}
		if len(pending) < batch {
			break
		}
	}
	return s.SetMeta(ctx, metaToolFields, toolFieldsVersion)
}
