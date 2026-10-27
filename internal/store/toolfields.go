package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strconv"
	"time"

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

// toolFieldsVersion names how the fields are derived. Raising it marks every
// stored event pending again on the next Open, so a change to drillKey
// reaches the calls stored before it.
const toolFieldsVersion = "1"

const (
	// metaToolFields is the toolFieldsVersion the stored fields were made by.
	metaToolFields = "tool_fields_version"
	// metaToolFieldsPending is the highest event id whose fields are not yet
	// filled: every id at or below it is read from its payload, every id
	// above it from tool_fields. 0 when all are filled.
	metaToolFieldsPending = "tool_fields_pending"
)

// toolFieldsPending is metaToolFieldsPending as a query reads it: a constant
// subquery, evaluated once per statement.
const toolFieldsPending = `(SELECT COALESCE(MAX(CAST(v AS INTEGER)), 0) FROM meta WHERE k = '` + metaToolFieldsPending + `')`

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

// agentTaskIndex is idx_events_agent_task (migration 0054) on sid. Migration
// 0073 rebuilt events without it, so it is put back while a fill is pending,
// for describeSubagents to seek the results not yet filled.
const agentTaskIndex = `CREATE INDEX IF NOT EXISTS idx_events_agent_task
	ON events(sid, ` + agentTaskID + `, ` + agentTaskDesc + `)
	WHERE kind = 'tool.post' AND tool IN ('Agent', 'Task')`

// markToolFieldsPending runs on Open: when the stored fields were made by
// another toolFieldsVersion, or the table is new (migration 0070), every
// event stored so far becomes pending. It reads one value and writes two, so
// Open stays as fast as before; ToolFieldsStep does the reading, in the
// background.
func (s *Store) markToolFieldsPending(ctx context.Context) error {
	v, err := s.GetMeta(ctx, metaToolFields)
	if err != nil {
		return err
	}
	if v == toolFieldsVersion {
		if v, err := s.GetMeta(ctx, metaToolFieldsPending); err != nil || v == "" || v == "0" {
			return err
		}
		_, err := s.db.ExecContext(ctx, agentTaskIndex)
		return err
	}
	return s.WithTx(ctx, func(q Querier) error {
		if _, err := q.ExecContext(ctx, `
			INSERT INTO meta(k, v) SELECT ?, COALESCE(MAX(id), 0) FROM events WHERE true
			ON CONFLICT(k) DO UPDATE SET v = excluded.v`, metaToolFieldsPending); err != nil {
			return err
		}
		if _, err := q.ExecContext(ctx, `INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
			metaToolFields, toolFieldsVersion); err != nil {
			return err
		}
		// A database with nothing to fill never runs the step that drops
		// the index the fill keeps.
		var pending int64
		if err := q.QueryRowContext(ctx, `SELECT `+toolFieldsPending).Scan(&pending); err != nil {
			return err
		}
		if pending > 0 {
			_, err := q.ExecContext(ctx, agentTaskIndex)
			return err
		}
		_, err := q.ExecContext(ctx, `DROP INDEX IF EXISTS idx_events_agent_task`)
		return err
	})
}

// ToolFieldsStep fills the fields of up to window pending event ids, the
// newest first, and moves the pending mark below them in the same
// transaction: an interrupted pass resumes where it stopped, and a reader
// never sees a row as filled before it is. Done when nothing is pending.
func (s *Store) ToolFieldsStep(ctx context.Context, window int) (filled int, done bool, err error) {
	if window <= 0 {
		window = 1000
	}
	v, err := s.GetMeta(ctx, metaToolFieldsPending)
	if err != nil {
		return 0, false, err
	}
	hi, _ := strconv.ParseInt(v, 10, 64)
	if hi <= 0 {
		return 0, true, nil
	}
	lo := max(hi-int64(window), 0)
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, kind, COALESCE(tool, ''), payload FROM events
		 WHERE id > ? AND id <= ? AND kind IN ('tool.pre', 'tool.post')`, lo, hi)
	if err != nil {
		return 0, false, err
	}
	type row struct {
		id int64
		f  toolFields
		ok bool
	}
	var pending []row
	for rows.Next() {
		var r row
		var kind, tool string
		var payload []byte
		if err := rows.Scan(&r.id, &kind, &tool, &payload); err != nil {
			_ = rows.Close()
			return 0, false, err
		}
		r.f, r.ok = readToolFields(event.Kind(kind), tool, payload)
		pending = append(pending, r)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return 0, false, err
	}
	if err := rows.Close(); err != nil {
		return 0, false, err
	}
	err = s.WithTx(ctx, func(q Querier) error {
		for _, r := range pending {
			var err error
			if r.ok {
				err = putToolFields(ctx, q, r.id, r.f)
			} else {
				// A result made by an older derivation that now has nothing
				// to keep.
				_, err = q.ExecContext(ctx, `DELETE FROM tool_fields WHERE event_id = ?`, r.id)
			}
			if err != nil {
				return err
			}
		}
		if _, err := q.ExecContext(ctx, `UPDATE meta SET v = ? WHERE k = ?`, strconv.FormatInt(lo, 10), metaToolFieldsPending); err != nil {
			return err
		}
		if lo > 0 {
			return nil
		}
		// Nothing reads a result's payload for its subagent any more: the
		// index that did, kept for the fill (migration 0070), goes with it.
		_, err := q.ExecContext(ctx, `DROP INDEX IF EXISTS idx_events_agent_task`)
		return err
	})
	if err != nil {
		return 0, false, err
	}
	return len(pending), lo == 0, nil
}

// FillToolFields runs ToolFieldsStep until nothing is pending, resting
// between steps so ingest and the dashboard always find the database free.
func (s *Store) FillToolFields(ctx context.Context, window int, pause time.Duration) (int, error) {
	total := 0
	for {
		n, done, err := s.ToolFieldsStep(ctx, window)
		total += n
		if err != nil || done {
			return total, err
		}
		select {
		case <-ctx.Done():
			return total, ctx.Err()
		case <-time.After(pause):
		}
	}
}
