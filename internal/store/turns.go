package store

import (
	"context"
	"encoding/json"
	"strings"
	"time"
)

// A Claude Code turn, as the Queue view counts it: from the hooks'
// UserPromptSubmit (turn.user) to the main thread's next Stop (agent.stop)
// or StopFailure (throttle). A prompt followed by another prompt before any
// Stop was interrupted (Escape sends no Stop) and is not a turn. A
// subagent's SubagentStop carries an agent id and ends nothing. Only the hook
// plane says when a turn ended, so other agents, and Claude Code without
// hooks, have no turns here (.ai/03-contracts.md § Queue).

// Turn is one finished turn, or the open one (End 0).
type Turn struct {
	SessionID string
	// PromptID is the turn.user event's id, to read its prompt.
	PromptID int64
	Start    int64 // unix ms
	End      int64 // unix ms; 0 while it runs
	// Failed: it ended on a StopFailure.
	Failed bool
}

// Duration is the finished turn's length.
func (t Turn) Duration() time.Duration { return time.Duration(t.End-t.Start) * time.Millisecond }

// turnBoundsSQL reads the turn bounds of a set of sessions in (session, time)
// order. It pins idx_events_turn_bounds (migration 0048), partial to exactly
// these rows and covering them: 1 ms for the owner's largest project, against
// 1.6 s cold through idx_events_kind_id (2026-10-12).
const turnBoundsSQL = `
	SELECT e.id, (SELECT session_id FROM sessions WHERE sessions.sid = e.sid), e.ts, e.kind
	  FROM events e INDEXED BY idx_events_turn_bounds
	 WHERE e.source = 'hook' AND e.kind IN ('turn.user', 'agent.stop', 'throttle')
	   AND COALESCE(e.agent_id, '') = '' AND e.ts >= ?
	   AND e.sid IN (SELECT sid FROM sessions WHERE session_id IN (%s))
	 ORDER BY e.sid, e.ts`

// foldTurns pairs bounds, read in (session, ts) order, into turns: the
// finished ones oldest-first by end, and each session's open turn.
func foldTurns(rows []turnBound) (done []Turn, open map[string]Turn) {
	open = map[string]Turn{}
	var cur *Turn
	session := ""
	flush := func() {
		if cur != nil {
			open[cur.SessionID] = *cur
		}
		cur = nil
	}
	for _, b := range rows {
		if b.session != session {
			flush()
			session = b.session
		}
		switch b.kind {
		case "turn.user":
			cur = &Turn{SessionID: b.session, PromptID: b.id, Start: b.ts}
		default: // agent.stop, throttle
			if cur != nil {
				cur.End = b.ts
				cur.Failed = b.kind == "throttle"
				done = append(done, *cur)
				cur = nil
			}
		}
	}
	flush()
	sortTurnsByEnd(done)
	return done, open
}

type turnBound struct {
	id      int64
	session string
	ts      int64
	kind    string
}

func sortTurnsByEnd(ts []Turn) {
	// Insertion sort keeps equal ends in read order; the lists are short
	// (a project's window, a few hours of owned sessions).
	for i := 1; i < len(ts); i++ {
		for j := i; j > 0 && ts[j].End < ts[j-1].End; j-- {
			ts[j], ts[j-1] = ts[j-1], ts[j]
		}
	}
}

func readTurnBounds(ctx context.Context, q Querier, sessionsSQL string, args []any, since int64) ([]turnBound, error) {
	rows, err := q.QueryContext(ctx, strings.Replace(turnBoundsSQL, "%s", sessionsSQL, 1), append([]any{since}, args...)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []turnBound
	for rows.Next() {
		var b turnBound
		if err := rows.Scan(&b.id, &b.session, &b.ts, &b.kind); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

// ProjectTurns returns the newest limit finished turns of the Claude Code
// sessions in one project — the repository root, else the folder, as Cost
// groups them — that ended at or after since, oldest first.
func ProjectTurns(ctx context.Context, q Querier, dir string, since time.Time, limit int) ([]Turn, error) {
	bounds, err := readTurnBounds(ctx, q,
		`SELECT session_id FROM sessions WHERE agent = 'claude' AND COALESCE(NULLIF(repo_root, ''), cwd) = ?`,
		[]any{dir}, since.UnixMilli())
	if err != nil {
		return nil, err
	}
	done, _ := foldTurns(bounds)
	if limit > 0 && len(done) > limit {
		done = done[len(done)-limit:]
	}
	return done, nil
}

// SessionTurns returns the given sessions' turns that ended at or after
// since, oldest first, and each one's open turn, read from lookback before
// since so a turn that started earlier is whole.
func SessionTurns(ctx context.Context, q Querier, ids []string, since time.Time, lookback time.Duration) ([]Turn, map[string]Turn, error) {
	if len(ids) == 0 {
		return nil, map[string]Turn{}, nil
	}
	args := make([]any, len(ids))
	for i, id := range ids {
		args[i] = id
	}
	bounds, err := readTurnBounds(ctx, q, "?"+strings.Repeat(", ?", len(ids)-1), args, since.Add(-lookback).UnixMilli())
	if err != nil {
		return nil, nil, err
	}
	done, open := foldTurns(bounds)
	cut := since.UnixMilli()
	kept := done[:0]
	for _, t := range done {
		if t.End >= cut {
			kept = append(kept, t)
		}
	}
	return kept, open, nil
}

// RecentOwnedSessions returns the sessions Caprock started that recorded
// anything at or after since.
func RecentOwnedSessions(ctx context.Context, q Querier, since time.Time) ([]string, error) {
	rows, err := q.QueryContext(ctx, `SELECT session_id FROM sessions WHERE owned = 1 AND last_event_at >= ?`, since.UnixMilli())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// PromptTexts returns the prompt of each turn.user event by id, as typed
// (payload.prompt, else payload.text), clipped to limit runes.
func PromptTexts(ctx context.Context, q Querier, ids []int64, limit int) (map[int64]string, error) {
	out := map[int64]string{}
	if len(ids) == 0 {
		return out, nil
	}
	args := make([]any, len(ids))
	for i, id := range ids {
		args[i] = id
	}
	rows, err := q.QueryContext(ctx, `SELECT id, payload FROM events WHERE id IN (?`+strings.Repeat(", ?", len(ids)-1)+`)`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			id      int64
			payload []byte
		)
		if err := rows.Scan(&id, &payload); err != nil {
			return nil, err
		}
		var p struct {
			Prompt string `json:"prompt"`
			Text   string `json:"text"`
		}
		_ = json.Unmarshal(payload, &p)
		s := strings.TrimSpace(p.Prompt)
		if s == "" {
			s = strings.TrimSpace(p.Text)
		}
		if r := []rune(s); limit > 0 && len(r) > limit {
			s = string(r[:limit]) + "…"
		}
		out[id] = s
	}
	return out, rows.Err()
}
