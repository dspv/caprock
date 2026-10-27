package chatimport

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/store"
)

// Result is what one import did, counted per conversation.
type Result struct {
	// Conversations is how many the export held that had something to read.
	Conversations int `json:"conversations"`
	// Added is new chats; Updated is chats already imported that the export
	// carried new messages for; Unchanged is chats already imported as they
	// are.
	Added     int `json:"added"`
	Updated   int `json:"updated"`
	Unchanged int `json:"unchanged"`
	// Deleted is conversations the user deleted from Caprock after an earlier
	// import: they stay deleted (ADR-037's tombstone).
	Deleted int `json:"deleted"`
	// Empty is conversations with no message to show.
	Empty int `json:"empty"`
	// Messages is how many messages were added.
	Messages int `json:"messages"`
	// Sources counts the conversations read per source.
	Sources map[string]int `json:"sources"`
}

// SessionID is the Caprock session an imported conversation is stored as:
// the source and the service's own id, so importing the same export again
// lands on the same row.
func SessionID(source, id string) string {
	prefix := "chatgpt-"
	if source == SourceClaudeAI {
		prefix = "claudeai-"
	}
	return prefix + id
}

// promptMax caps the first message kept on the session row, which names a
// chat before it has a title and is searched with the rest of the row.
const promptMax = 2000

// Save files one conversation as a read-only chat and counts what it did.
//
// The conversation is a session (ADR-071: a chat is a session) with
// `chat = 1`, `status = 'ended'`, no folder, no process, the source as its
// agent and the service's id as its native id. Each message is an event
// keyed by the service's message id, so a re-import adds only the messages
// that are new. The events carry no tokens and no cost and are marked
// `internal`, which every aggregate already leaves out: a conversation held
// on Claude.ai or ChatGPT is not work done on this machine, and must not move
// a day's activity or spend. The conversation view reads them all the same.
// No daily row, no session_stats row: nothing to take back out on delete.
func Save(ctx context.Context, st *store.Store, c Conversation, res *Result) error {
	if res.Sources == nil {
		res.Sources = map[string]int{}
	}
	if len(c.Messages) == 0 {
		res.Empty++
		return nil
	}
	res.Conversations++
	res.Sources[c.Source]++
	id := SessionID(c.Source, c.ID)
	added := 0
	existed := false
	deleted := false
	err := st.WithTx(ctx, func(q store.Querier) error {
		added, existed, deleted = 0, false, false
		removed, err := store.IsRemoved(ctx, q, id)
		if err != nil {
			return err
		}
		if removed {
			deleted = true
			return nil
		}
		var one int
		switch err := q.QueryRowContext(ctx, `SELECT 1 FROM sessions WHERE session_id = ?`, id).Scan(&one); {
		case err == nil:
			existed = true
		case !errors.Is(err, sql.ErrNoRows):
			return err
		}
		prompt := ""
		for _, m := range c.Messages {
			if m.Role == "user" {
				prompt = clipRunes(m.Text, promptMax)
				break
			}
		}
		if _, err := q.ExecContext(ctx, `
			INSERT INTO sessions(session_id, cwd, project, model, started_at, last_event_at, worked_at,
			                     status, agent, title, prompt, native_id, chat)
			VALUES(?, '', '', ?, ?, ?, ?, 'ended', ?, ?, ?, ?, 1)
			ON CONFLICT(session_id) DO UPDATE SET
			  model         = COALESCE(NULLIF(excluded.model, ''), sessions.model),
			  title         = COALESCE(NULLIF(excluded.title, ''), sessions.title),
			  prompt        = COALESCE(NULLIF(sessions.prompt, ''), excluded.prompt),
			  started_at    = MIN(sessions.started_at, excluded.started_at),
			  last_event_at = MAX(sessions.last_event_at, excluded.last_event_at),
			  worked_at     = MAX(sessions.worked_at, excluded.worked_at)`,
			id, c.Model, c.Created.UnixMilli(), c.Updated.UnixMilli(), c.Updated.UnixMilli(),
			c.Source, c.Title, prompt, c.ID); err != nil {
			return err
		}
		for _, m := range c.Messages {
			ev := &event.Event{
				Ts: m.At, SessionID: id, Source: event.SourceImport,
				Key: "imp:" + m.ID,
			}
			fields := map[string]any{"imported_from": c.Source}
			if m.Role == "user" {
				ev.Kind = event.KindTurnUser
				fields["prompt"] = m.Text
			} else {
				ev.Kind = event.KindTurnAssistant
				ev.MsgID = c.Source + "/" + m.ID
				fields["text"] = m.Text
				if c.Model != "" {
					fields["model"] = c.Model
				}
			}
			ev.Payload = marshal(fields)
			eid, err := store.InsertEvent(ctx, q, ev)
			if errors.Is(err, store.ErrDuplicate) {
				continue
			}
			if err != nil {
				return err
			}
			if _, err := q.ExecContext(ctx, `UPDATE events SET internal = 1 WHERE id = ?`, eid); err != nil {
				return err
			}
			added++
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("import %s conversation %s: %w", SourceName(c.Source), c.ID, err)
	}
	switch {
	case deleted:
		res.Deleted++
	case !existed:
		res.Added++
	case added > 0:
		res.Updated++
	default:
		res.Unchanged++
	}
	res.Messages += added
	return nil
}

// Import reads an export file and saves every conversation in it.
func Import(ctx context.Context, st *store.Store, path string) (Result, error) {
	res := Result{Sources: map[string]int{}}
	err := File(path, func(c Conversation) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		return Save(ctx, st, c, &res)
	})
	return res, err
}

// marshal writes the payload without HTML escaping: the session search reads
// prompts with LIKE, and "<" stored as < would not be found.
func marshal(v any) json.RawMessage {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
	return json.RawMessage(bytes.TrimRight(b.Bytes(), "\n"))
}

func clipRunes(s string, n int) string {
	s = strings.TrimSpace(s)
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}
