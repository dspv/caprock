package store

import (
	"context"
	"errors"
	"strings"
	"unicode/utf8"
)

// What Caprock did on its own, for Jarvis's Handled for you (ADR-096,
// migration 0082, 03-contracts.md § Jarvis handled DDL).

// The kinds of HandledItem.
const (
	HandledLimitSwitch = "limit_switch" // moved to another sign-in at a usage limit
	HandledLimitReturn = "limit_return" // moved back after the window reset
	HandledLimitResume = "limit_resume" // "continue" typed after the limit reset
	HandledEndDone     = "end_done"     // ended when its turn finished (end_when_done)
	HandledIdleEnd     = "idle_end"     // ended idle with no tab open
	HandledMorning     = "morning"      // the morning summary went to Telegram
	HandledAutoAnswer  = "auto_answer"  // the Jarvis brain answered a routine question
)

// HandledUndoContinueOn undoes a move: continue the session named back on
// the target it left (POST /v1/sessions/{id}/continue-on).
const HandledUndoContinueOn = "continue_on"

// HandledItem is one row of the log.
type HandledItem struct {
	ID int64 `json:"id"`
	// At is when it was done (unix ms).
	At        int64  `json:"at"`
	Kind      string `json:"kind"`
	SessionID string `json:"session_id,omitempty"`
	Project   string `json:"project,omitempty"`
	// Text is one line in plain words: what was done.
	Text string `json:"text"`
	// Reason is why, when it is worth a line.
	Reason string       `json:"reason,omitempty"`
	Undo   *HandledUndo `json:"undo,omitempty"`
}

// HandledUndo is the action that undoes an item.
type HandledUndo struct {
	Kind      string `json:"kind"`
	SessionID string `json:"session_id"`
	// Target is where continue_on takes the session back to, in
	// continue-on's terms ("default", a subscription id, …).
	Target string `json:"target,omitempty"`
}

// handledKeep is how long a row is kept.
const handledKeep = 30 * 24 * 60 * 60 * 1000

// handledTextMax and handledReasonMax bound the two texts, in runes.
const (
	handledTextMax   = 300
	handledReasonMax = 600
)

// HandledListMax is the most rows one read returns.
const HandledListMax = 200

// AddHandled writes one item and returns it with its id; rows older than
// 30 days before it go.
func AddHandled(ctx context.Context, q Querier, it HandledItem) (HandledItem, error) {
	it.Text = clipHandled(it.Text, handledTextMax)
	it.Reason = clipHandled(it.Reason, handledReasonMax)
	if it.Kind == "" || it.Text == "" || it.At <= 0 {
		return it, errors.New("a handled item needs a kind, a text and a time")
	}
	var uk, us, ut string
	if it.Undo != nil {
		uk, us, ut = it.Undo.Kind, it.Undo.SessionID, it.Undo.Target
	}
	res, err := q.ExecContext(ctx, `INSERT INTO jarvis_handled (at, kind, session_id, project, text, reason, undo_kind, undo_session, undo_target)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, it.At, it.Kind, it.SessionID, it.Project, it.Text, it.Reason, uk, us, ut)
	if err != nil {
		return it, err
	}
	if it.ID, err = res.LastInsertId(); err != nil {
		return it, err
	}
	_, err = q.ExecContext(ctx, `DELETE FROM jarvis_handled WHERE at < ?`, it.At-handledKeep)
	return it, err
}

// ListHandled is the items at or after since (unix ms), newest first, at
// most limit (1..HandledListMax).
func ListHandled(ctx context.Context, q Querier, since int64, limit int) ([]HandledItem, error) {
	if limit <= 0 || limit > HandledListMax {
		limit = HandledListMax
	}
	rows, err := q.QueryContext(ctx, `SELECT id, at, kind, session_id, project, text, reason, undo_kind, undo_session, undo_target
		FROM jarvis_handled WHERE at >= ? ORDER BY at DESC, id DESC LIMIT ?`, since, limit)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := []HandledItem{}
	for rows.Next() {
		var it HandledItem
		var uk, us, ut string
		if err := rows.Scan(&it.ID, &it.At, &it.Kind, &it.SessionID, &it.Project, &it.Text, &it.Reason, &uk, &us, &ut); err != nil {
			return nil, err
		}
		if uk != "" {
			it.Undo = &HandledUndo{Kind: uk, SessionID: us, Target: ut}
		}
		out = append(out, it)
	}
	return out, rows.Err()
}

// CountHandledSince counts the items at or after since (unix ms).
func CountHandledSince(ctx context.Context, q Querier, since int64) (int, error) {
	var n int
	err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM jarvis_handled WHERE at >= ?`, since).Scan(&n)
	return n, err
}

func clipHandled(s string, n int) string {
	s = strings.TrimSpace(s)
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n-1]) + "…"
}
