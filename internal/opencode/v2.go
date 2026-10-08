package opencode

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// OpenCode 2, and why one database can hold both versions.
//
// OpenCode 2 (2.0.x, `@opencode/cli` on npm, what opencode.ai installs since
// 2026-10) keeps the same file, `~/.local/share/opencode/opencode.db`, and
// adds its own tables beside OpenCode 1's: sessions in `session_v2`, and every
// message of a session — the person's prompt, each assistant step with its
// cost, tokens, text and tool calls, the idle marker — as one row of
// `session_message` with the whole message as JSON in `data`. There is no
// `part` table: a tool call is an item of the assistant message's `content`.
//
// Measured on 2.0.26 against a scratch home (2026-10-09):
//
//   - A database OpenCode 1 made is migrated in place, not replaced. Its
//     `session`, `message` and `part` tables stay, and each OpenCode 1 session
//     is copied into `session_v2` under the same id. OpenCode 1 (1.15.10) also
//     writes its messages into `session_message` under the same message ids.
//   - A session started in OpenCode 1 and continued in OpenCode 2 therefore
//     has its first messages in both shapes and its later ones only in
//     `session_message`; the `session` row stops moving and the `session_v2`
//     row carries on.
//
// So the reader takes a session from whichever table has it, and a message
// from OpenCode 1's tables when they have it — that is the shape its events
// were first stored under, tool calls keyed by part id — and from
// `session_message` otherwise. Nothing is counted twice and nothing a later
// OpenCode 2 turn adds is missed.

// tables reports which of the two schemas a database carries.
func tables(ctx context.Context, db *sql.DB) (v1, v2 bool, err error) {
	rows, err := db.QueryContext(ctx,
		`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('session','session_v2','session_message','message','part')`)
	if err != nil {
		return false, false, fmt.Errorf("opencode: tables: %w", err)
	}
	defer rows.Close()
	have := map[string]bool{}
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return false, false, err
		}
		have[n] = true
	}
	if err := rows.Err(); err != nil {
		return false, false, err
	}
	v1 = have["session"] && have["message"] && have["part"]
	v2 = have["session_v2"] && have["session_message"]
	if !v1 && !v2 {
		return false, false, errors.New("opencode: no session table in this database")
	}
	return v1, v2, nil
}

const sessionColsV2 = `
	SELECT id, COALESCE(parent_id,''), COALESCE(directory,''), COALESCE(title,''),
	       COALESCE(model,''), COALESCE(cost,0),
	       COALESCE(tokens_input,0), COALESCE(tokens_output,0),
	       COALESCE(tokens_cache_read,0), COALESCE(tokens_cache_write,0),
	       COALESCE(time_created,0), COALESCE(time_updated,0)
	FROM session_v2`

// scanSessions reads rows of the shape both session tables share.
func scanSessions(rows *sql.Rows, v2 bool) ([]Session, error) {
	defer rows.Close()
	var out []Session
	for rows.Next() {
		var s Session
		var modelJSON string
		if err := rows.Scan(&s.ID, &s.ParentID, &s.Directory, &s.Title, &modelJSON,
			&s.Cost, &s.TokensIn, &s.TokensOut, &s.CacheRead, &s.CacheWrite,
			&s.Created, &s.Updated); err != nil {
			return nil, fmt.Errorf("opencode: scan session: %w", err)
		}
		s.Model, s.Provider = parseModel(modelJSON)
		if v2 {
			s.InV2 = true
		} else {
			s.InV1 = true
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// merge joins a session read from both tables into one. The OpenCode 2 row is
// the one that keeps moving once a session is continued there, so its totals,
// title and update time win when it is the newer; the model falls back to
// OpenCode 1's, because OpenCode 2 leaves the column empty on the sessions it
// starts.
func merge(v1, v2 Session) Session {
	out := v1
	if v2.Updated >= v1.Updated {
		out = v2
		if out.Model == "" {
			out.Model, out.Provider = v1.Model, v1.Provider
		}
		if out.Title == "" {
			out.Title = v1.Title
		}
	}
	out.InV1, out.InV2 = true, true
	return out
}

// v2Message is the part of a session_message row's `data` the reader uses.
// The shapes are OpenCode 2's own (Session.Message.User, .Assistant and
// .Compaction in its schema); fields it never reads are not declared.
type v2Message struct {
	Text  string `json:"text"`
	Agent string `json:"agent"`
	Model struct {
		ID         string `json:"id"`
		ProviderID string `json:"providerID"`
	} `json:"model"`
	Content []v2Content `json:"content"`
	Status  string      `json:"status"` // compaction: running, completed, failed
	Cost    float64     `json:"cost"`
	Tokens  struct {
		Input  int64 `json:"input"`
		Output int64 `json:"output"`
		Cache  struct {
			Read  int64 `json:"read"`
			Write int64 `json:"write"`
		} `json:"cache"`
	} `json:"tokens"`
	Time struct {
		Created   int64 `json:"created"`
		Completed int64 `json:"completed"`
	} `json:"time"`
}

// v2Content is one item of an assistant message: `text`, `reasoning` or
// `tool`.
type v2Content struct {
	Type  string `json:"type"`
	Text  string `json:"text"`
	ID    string `json:"id"`   // a tool call's id, as the provider gave it
	Name  string `json:"name"` // a tool's name: shell, read, edit, subagent…
	State struct {
		Status string          `json:"status"` // streaming, running, completed, error
		Input  json.RawMessage `json:"input"`
	} `json:"state"`
	Time struct {
		Created   int64 `json:"created"`
		Ran       int64 `json:"ran"`
		Completed int64 `json:"completed"`
	} `json:"time"`
}

// readV2 returns one session's messages, tool calls and text parts from
// OpenCode 2's `session_message`, in the shapes the OpenCode 1 readers
// return, so the ingester stores both the same way.
//
//   - `user` is what the person typed; `assistant` is one model step with its
//     own cost and tokens; a completed or failed `compaction` is a model call
//     that cost money and is stored as a turn without prose.
//   - `synthetic` and `system` are OpenCode's own text (a plan-mode reminder,
//     "the `bash` tool is now `shell`"), `shell` is a command the person ran
//     with `!`, and `idle`, `agent-switched`, `model-switched` and
//     `location-switched` are markers. None is a prompt or a reply.
//   - A tool call has no row of its own and no part id. It is keyed by its
//     message and its call id, which is unique within a message.
func readV2(ctx context.Context, db *sql.DB, sessionID string) ([]Message, []ToolCall, map[string][]string, error) {
	const q = `
		SELECT id, type, data FROM session_message
		WHERE session_id = ? AND type IN ('user','assistant','compaction')
		ORDER BY seq ASC`
	rows, err := db.QueryContext(ctx, q, sessionID)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("opencode: session messages: %w", err)
	}
	defer rows.Close()

	var msgs []Message
	var calls []ToolCall
	parts := map[string][]string{}
	for rows.Next() {
		var id, typ, data string
		if err := rows.Scan(&id, &typ, &data); err != nil {
			return nil, nil, nil, fmt.Errorf("opencode: scan session message: %w", err)
		}
		var d v2Message
		if err := json.Unmarshal([]byte(data), &d); err != nil {
			continue // one unreadable row must not abort an import
		}
		m := Message{
			ID: id, SessionID: sessionID,
			Model: d.Model.ID, Provider: d.Model.ProviderID,
			Cost:     d.Cost,
			TokensIn: d.Tokens.Input, TokensOut: d.Tokens.Output,
			CacheRead: d.Tokens.Cache.Read, CacheWrite: d.Tokens.Cache.Write,
			Created: d.Time.Created, Completed: d.Time.Completed,
		}
		switch typ {
		case "user":
			m.Role = "user"
			if t := strings.TrimSpace(d.Text); t != "" {
				parts[id] = append(parts[id], t)
			}
		case "assistant":
			m.Role = "assistant"
			for i, c := range d.Content {
				switch c.Type {
				case "text":
					if t := strings.TrimSpace(c.Text); t != "" {
						parts[id] = append(parts[id], t)
					}
				case "tool":
					calls = append(calls, v2Call(id, sessionID, i, c))
				}
				// reasoning is the model's thinking and is never read.
			}
		case "compaction":
			if d.Status == "running" {
				continue // not yet a call with a cost
			}
			m.Role = "assistant"
		}
		msgs = append(msgs, m)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, nil, err
	}
	return msgs, calls, parts, nil
}

// v2Call is one tool item of an assistant message as a ToolCall.
func v2Call(msgID, sessionID string, i int, c v2Content) ToolCall {
	call := c.ID
	if call == "" {
		call = fmt.Sprintf("#%d", i)
	}
	start := c.Time.Ran
	if start == 0 {
		start = c.Time.Created
	}
	return ToolCall{
		ID: msgID + "/" + call, MessageID: msgID, SessionID: sessionID,
		Tool: NormalizeTool(c.Name), RawTool: c.Name,
		FilePath: filePathFrom(c.State.Input),
		Input:    c.State.Input,
		Status:   c.State.Status,
		Start:    start, End: c.Time.Completed,
	}
}

// Read returns everything one session holds: its messages in order, its tool
// calls, and the text of each message, from whichever schema has them (see
// the note at the top of this file).
func Read(ctx context.Context, db *sql.DB, s Session) ([]Message, []ToolCall, map[string][]string, error) {
	if !s.InV1 && !s.InV2 {
		s.InV1 = true // a Session built by hand: the original schema
	}
	var msgs []Message
	var calls []ToolCall
	parts := map[string][]string{}
	if s.InV1 {
		var err error
		if msgs, err = Messages(ctx, db, s.ID); err != nil {
			return nil, nil, nil, err
		}
		if calls, err = ToolCalls(ctx, db, s.ID); err != nil {
			return nil, nil, nil, err
		}
		if parts, err = TextParts(ctx, db, s.ID); err != nil {
			return nil, nil, nil, err
		}
	}
	if !s.InV2 {
		return msgs, calls, parts, nil
	}
	m2, c2, p2, err := readV2(ctx, db, s.ID)
	if err != nil {
		return nil, nil, nil, err
	}
	have := make(map[string]bool, len(msgs))
	for _, m := range msgs {
		have[m.ID] = true
	}
	for _, m := range m2 {
		if have[m.ID] {
			continue // stored from OpenCode 1's tables, under their keys
		}
		if m.Role == "assistant" && m.Model == "" {
			// A compaction need not name a model; it ran on the session's.
			for i := len(msgs) - 1; i >= 0; i-- {
				if msgs[i].Model != "" {
					m.Model, m.Provider = msgs[i].Model, msgs[i].Provider
					break
				}
			}
		}
		msgs = append(msgs, m)
		if p, ok := p2[m.ID]; ok {
			parts[m.ID] = p
		}
	}
	for _, c := range c2 {
		if !have[c.MessageID] {
			calls = append(calls, c)
		}
	}
	return msgs, calls, parts, nil
}
