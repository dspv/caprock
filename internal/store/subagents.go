package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
)

// maxSubagentsShown bounds the working subagents read in detail: each costs
// a few indexed lookups, and the cockpit draws at most two rows of twelve.
const maxSubagentsShown = 24

// SubagentActivity is one subagent working in a session now: who it is and
// what it is doing, read from the hooks fired inside it (they carry its
// agent_id) — Claude Code sends no event when a subagent starts.
type SubagentActivity struct {
	AgentID string
	// AgentType is the hook's agent_type ("general-purpose", "Explore"); empty
	// when no hook named one.
	AgentType string
	// Description is what the parent asked it to do, from the Agent call
	// that launched it, when its result names the agent (a background launch
	// does at once; a foreground one only when it finishes).
	Description string
	// ToolCalls is how many tool calls it has made in all.
	ToolCalls int
	// StartedAt and LastAt are its first and newest events in the window, unix ms.
	StartedAt, LastAt int64
	// Tool, Input and ToolAt are its newest call; empty when it made none.
	Tool   string
	Input  json.RawMessage
	ToolAt int64
	// Running is true while that call has no result.
	Running bool
	// StoppedAt is its SubagentStop (unix ms), for one that finished.
	StoppedAt int64
	// Asking is true when its newest event is a permission prompt: a
	// subagent waiting on a dialog records nothing else.
	Asking bool
}

// SubagentsNow returns the subagents working in a session — each agent id
// heard from since `since` whose newest event is not its SubagentStop, the
// rule LiveSubagents counts by — newest activity first, and how many stopped
// within the window after making at least one tool call. Claude Code also
// fires SubagentStop for small internal agents that run no tools; they are
// not counted.
func SubagentsNow(ctx context.Context, q Querier, sessionID string, since int64) ([]SubagentActivity, int, error) {
	rows, err := q.QueryContext(ctx, `
		SELECT agent_id, MIN(ts), MAX(ts),
		       MAX(CASE WHEN kind = 'agent.stop' THEN ts ELSE 0 END),
		       SUM(kind = 'tool.pre')
		  FROM events
		 WHERE session_id = ? AND ts >= ? AND agent_id IS NOT NULL AND agent_id <> ''
		 GROUP BY agent_id
		 ORDER BY MAX(ts) DESC`, sessionID, since)
	if err != nil {
		return nil, 0, err
	}
	var working []SubagentActivity
	finished := 0
	for rows.Next() {
		var a SubagentActivity
		var stopped int64
		var calls int
		if err := rows.Scan(&a.AgentID, &a.StartedAt, &a.LastAt, &stopped, &calls); err != nil {
			_ = rows.Close()
			return nil, 0, err
		}
		switch {
		case stopped < a.LastAt:
			working = append(working, a)
		case calls > 0:
			finished++
		}
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, 0, err
	}
	if err := rows.Close(); err != nil {
		return nil, 0, err
	}
	if len(working) > maxSubagentsShown {
		working = working[:maxSubagentsShown]
	}
	if len(working) == 0 {
		return nil, finished, nil
	}
	for i := range working {
		if err := fillSubagent(ctx, q, sessionID, &working[i]); err != nil {
			return nil, 0, err
		}
	}
	if err := countSubagentCalls(ctx, q, sessionID, working); err != nil {
		return nil, 0, err
	}
	if err := describeSubagents(ctx, q, sessionID, working); err != nil {
		return nil, 0, err
	}
	return working, finished, nil
}

// Every query here names `+kind`, so SQLite walks the session's own rows
// (idx_events_session_ts) instead of every tool.pre in the database
// (idx_events_kind_*): on the owner's database that was 1.1 s against 13 ms
// for a 16,000-event session.
//
// The per-agent groupings spell `agent_id IS NOT NULL AND agent_id <> ''`
// rather than COALESCE(agent_id, '') <> '': only the spelled-out form lets
// SQLite see that the partial idx_events_agent_ts (migration 0054: session,
// ts, agent, kind) holds every row they need, and read it alone instead of
// the session's rows from the table.

// countSubagentCalls fills ToolCalls for all of them in one pass. A call
// heard on both planes is one row (they share its key); one only the
// transcript saw is a row of its own, so the count is of distinct calls.
func countSubagentCalls(ctx context.Context, q Querier, sessionID string, working []SubagentActivity) error {
	args := []any{sessionID}
	for _, a := range working {
		args = append(args, a.AgentID)
	}
	rows, err := q.QueryContext(ctx, `
		SELECT agent_id, COUNT(DISTINCT COALESCE(json_extract(payload, '$.tool_use_id'), 'event:' || id))
		  FROM events WHERE session_id = ? AND +kind = 'tool.pre'
		   AND agent_id IN (?`+strings.Repeat(`, ?`, len(working)-1)+`)
		 GROUP BY agent_id`, args...)
	if err != nil {
		return err
	}
	defer func() { _ = rows.Close() }()
	n := map[string]int{}
	for rows.Next() {
		var id string
		var calls int
		if err := rows.Scan(&id, &calls); err != nil {
			return err
		}
		n[id] = calls
	}
	for i := range working {
		working[i].ToolCalls = n[working[i].AgentID]
	}
	return rows.Err()
}

// agentTaskID and agentTaskDesc are the agent id and the description a
// parent's Agent/Task result names, exactly as idx_events_agent_task
// (migration 0054) indexes them: SQLite matches an indexed expression by its
// text, so a query that spells either differently opens every payload again.
const (
	agentTaskID   = `(CASE WHEN json_valid(payload) THEN json_extract(payload, '$.tool_response.agentId') END)`
	agentTaskDesc = `(CASE WHEN json_valid(payload) THEN json_extract(payload, '$.tool_response.description') END)`
)

// describeSubagents fills Description from the parent's Agent calls whose
// result names the agent. Only the listed agents are looked up, each by its
// id in idx_events_agent_task, so no result payload is read: they hold the
// subagent's whole answer, and reading all of a busy session's on every
// refresh was 0.6 s (§ Subagent reads DDL).
func describeSubagents(ctx context.Context, q Querier, sessionID string, working []SubagentActivity) error {
	if len(working) == 0 {
		return nil
	}
	args := []any{sessionID}
	for _, a := range working {
		args = append(args, a.AgentID)
	}
	rows, err := q.QueryContext(ctx, `
		SELECT COALESCE(`+agentTaskID+`, ''), COALESCE(`+agentTaskDesc+`, '')
		  FROM events INDEXED BY idx_events_agent_task
		 WHERE session_id = ? AND kind = 'tool.post' AND tool IN ('Agent', 'Task')
		   AND `+agentTaskID+` IN (?`+strings.Repeat(`, ?`, len(working)-1)+`)`, args...)
	if err != nil {
		return err
	}
	defer func() { _ = rows.Close() }()
	desc := map[string]string{}
	for rows.Next() {
		var id, d string
		if err := rows.Scan(&id, &d); err != nil {
			return err
		}
		if id != "" && d != "" {
			desc[id] = d
		}
	}
	for i := range working {
		working[i].Description = desc[working[i].AgentID]
	}
	return rows.Err()
}

func fillSubagent(ctx context.Context, q Querier, sessionID string, a *SubagentActivity) error {
	var kind string
	err := q.QueryRowContext(ctx, `
		SELECT kind FROM events WHERE session_id = ? AND agent_id = ?
		 ORDER BY ts DESC, id DESC LIMIT 1`, sessionID, a.AgentID).Scan(&kind)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	a.Asking = kind == "permission.prompt"

	var payload []byte
	var use sql.NullString
	err = q.QueryRowContext(ctx, `
		SELECT COALESCE(tool, ''), ts, payload, json_extract(payload, '$.tool_use_id')
		  FROM events WHERE session_id = ? AND agent_id = ? AND +kind = 'tool.pre'
		 ORDER BY ts DESC, id DESC LIMIT 1`, sessionID, a.AgentID).Scan(&a.Tool, &a.ToolAt, &payload, &use)
	switch {
	case errors.Is(err, sql.ErrNoRows):
	case err != nil:
		return err
	default:
		var p struct {
			AgentType string          `json:"agent_type"`
			ToolInput json.RawMessage `json:"tool_input"`
		}
		_ = json.Unmarshal(payload, &p)
		a.AgentType, a.Input = p.AgentType, p.ToolInput
		a.Running = true
		if use.String != "" {
			var one int
			err := q.QueryRowContext(ctx, `
				SELECT 1 FROM events WHERE session_id = ? AND agent_id = ? AND +kind = 'tool.post' AND ts >= ?
				   AND json_extract(payload, '$.tool_use_id') = ? LIMIT 1`, sessionID, a.AgentID, a.ToolAt, use.String).Scan(&one)
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return err
			}
			a.Running = err != nil
		}
	}
	if a.AgentType == "" {
		// A subagent that made no call yet: its type is on whatever it sent.
		_ = q.QueryRowContext(ctx, `
			SELECT COALESCE(json_extract(payload, '$.agent_type'), '') FROM events
			 WHERE session_id = ? AND agent_id = ? AND ts >= ? AND json_extract(payload, '$.agent_type') <> ''
			 ORDER BY ts DESC LIMIT 1`, sessionID, a.AgentID, a.StartedAt).Scan(&a.AgentType)
	}
	return nil
}

// SubagentsDone returns up to limit subagents of a session that stopped
// since `since` after making at least one tool call, newest stop first: the
// ones SubagentsNow counts as finished. StoppedAt is their SubagentStop.
func SubagentsDone(ctx context.Context, q Querier, sessionID string, since int64, limit int) ([]SubagentActivity, error) {
	rows, err := q.QueryContext(ctx, `
		SELECT agent_id, MIN(ts), MAX(ts),
		       MAX(CASE WHEN kind = 'agent.stop' THEN ts ELSE 0 END) AS stopped,
		       SUM(kind = 'tool.pre') AS calls
		  FROM events
		 WHERE session_id = ? AND ts >= ? AND agent_id IS NOT NULL AND agent_id <> ''
		 GROUP BY agent_id
		HAVING stopped >= MAX(ts) AND calls > 0
		 ORDER BY stopped DESC
		 LIMIT ?`, sessionID, since, limit)
	if err != nil {
		return nil, err
	}
	var done []SubagentActivity
	for rows.Next() {
		var a SubagentActivity
		var calls int
		if err := rows.Scan(&a.AgentID, &a.StartedAt, &a.LastAt, &a.StoppedAt, &calls); err != nil {
			_ = rows.Close()
			return nil, err
		}
		done = append(done, a)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	if len(done) == 0 {
		return nil, nil
	}
	if err := typeSubagents(ctx, q, sessionID, since, done); err != nil {
		return nil, err
	}
	if err := countSubagentCalls(ctx, q, sessionID, done); err != nil {
		return nil, err
	}
	if err := describeSubagents(ctx, q, sessionID, done); err != nil {
		return nil, err
	}
	return done, nil
}

// typeSubagents fills AgentType for each of them: the newest type any of its
// events in the window named (a SubagentStop often names none). One lookup
// per agent, newest first through idx_events_agent, that stops at the first
// event naming a type — nearly always the newest. Reading the type off every
// event of every listed agent in the window, as one pass did, opened all
// their payloads: 0.28 s for thirty finished agents of a busy session
// (2026-10-14), on every refresh of an opened "+N finished".
func typeSubagents(ctx context.Context, q Querier, sessionID string, since int64, list []SubagentActivity) error {
	for i := range list {
		var t string
		err := q.QueryRowContext(ctx, `
			SELECT json_extract(payload, '$.agent_type') FROM events
			 WHERE session_id = ? AND agent_id = ? AND ts >= ?
			   AND json_extract(payload, '$.agent_type') <> ''
			 ORDER BY ts DESC, id DESC LIMIT 1`, sessionID, list[i].AgentID, since).Scan(&t)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		list[i].AgentType = t
	}
	return nil
}

// SubagentSpend is what a subagent's own model calls cost, from its
// transcript's turns (each carries its model and usage, and is priced like
// any other turn).
type SubagentSpend struct {
	// Model is its newest turn's model; empty when it has none yet.
	Model string
	// CostUSD sums its turns' costs. Known is false when it has no turn, or
	// a turn the pricing table could not price: a partial sum would
	// understate it, and no figure is better than a wrong one (rule 6).
	CostUSD float64
	Known   bool
}

// SubagentsSpend returns each subagent's spend in a session, keyed by agent
// id, and the total over all of them, Known only when every one is.
// Internal model calls are left out, as every total leaves them out.
func SubagentsSpend(ctx context.Context, q Querier, sessionID string) (map[string]SubagentSpend, SubagentSpend, error) {
	// One MAX() in the select: SQLite takes the bare `model` from its row,
	// the agent's newest turn. Pinned to its covering index (migration 0054):
	// the session's own index walked the parent's rows too and read each
	// from the table, 75 ms warm on a 96,000-event session.
	rows, err := q.QueryContext(ctx, `
		SELECT agent_id, MAX(ts), COALESCE(model, ''), COUNT(*),
		       SUM(cost_usd IS NULL AND tokens_in IS NOT NULL), COALESCE(SUM(cost_usd), 0)
		  FROM events INDEXED BY idx_events_subagent_turn
		 WHERE session_id = ? AND kind = 'turn.assistant' AND agent_id IS NOT NULL AND agent_id <> '' AND internal = 0
		 GROUP BY agent_id`, sessionID)
	if err != nil {
		return nil, SubagentSpend{}, err
	}
	defer func() { _ = rows.Close() }()
	out := map[string]SubagentSpend{}
	total := SubagentSpend{Known: true}
	for rows.Next() {
		var id, model string
		var last int64
		var turns, unpriced int
		var usd float64
		if err := rows.Scan(&id, &last, &model, &turns, &unpriced, &usd); err != nil {
			return nil, SubagentSpend{}, err
		}
		sp := SubagentSpend{Model: model, CostUSD: usd, Known: turns > 0 && unpriced == 0}
		out[id] = sp
		total.CostUSD += usd
		total.Known = total.Known && sp.Known
	}
	if len(out) == 0 {
		total.Known = false
	}
	return out, total, rows.Err()
}
