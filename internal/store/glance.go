package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sort"
)

// The extra aggregates the Now screen's At a glance block draws: who did the
// work, and what the bill was made of. Both are over a range ending now, like
// the history they sit beside.

// AgentSplit is the turns and cost of each agent's main threads and of its
// subagents in [from, to). to <= 0 means no upper bound.
//
// It reads in two steps so the big one is covered (idx_events_turn_agent,
// migration 0031): turns grouped by session and by whether they carry an agent
// id, without touching a payload; then, for each session with main-thread
// turns, one payload asks whether the session is a sidechain. That is the one
// mark MainThreadWhere reads besides agent_id, and OpenCode writes it on every
// turn of a child session, so one turn answers for the session. Reading it per
// event cost 3.5 s on the owner's database (2026-10-04).
func AgentSplit(ctx context.Context, q Querier, from, to int64) ([]WeekAgent, error) {
	upper, args := "", []any{from}
	if to > 0 {
		upper, args = " AND ts < ?", append(args, to)
	}
	rows, err := q.QueryContext(ctx, `
		SELECT session_id, COALESCE(agent_id,'') <> '', COUNT(*), COALESCE(SUM(cost_usd),0), COUNT(DISTINCT NULLIF(agent_id,''))
		FROM events INDEXED BY idx_events_turn_agent
		WHERE kind = 'turn.assistant' AND ts >= ?`+upper+nonInternalEvent+`
		GROUP BY 1, 2`, args...)
	if err != nil {
		return nil, err
	}
	type part struct {
		session        string
		sub            bool
		turns, threads int64
		cost           float64
	}
	var parts []part
	for rows.Next() {
		var p part
		if err := rows.Scan(&p.session, &p.sub, &p.turns, &p.cost, &p.threads); err != nil {
			_ = rows.Close()
			return nil, err
		}
		parts = append(parts, p)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, err
	}
	_ = rows.Close()

	agentOf := map[string]string{}
	sidechain := map[string]bool{}
	for _, p := range parts {
		if _, ok := agentOf[p.session]; !ok {
			var agent string
			err := q.QueryRowContext(ctx, `SELECT COALESCE(agent,'claude') FROM sessions WHERE session_id = ?`, p.session).Scan(&agent)
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return nil, err
			}
			if agent == "" {
				agent = "claude"
			}
			agentOf[p.session] = agent
		}
		if !p.sub {
			var side sql.NullInt64
			err := q.QueryRowContext(ctx, `
				SELECT json_extract(payload, '$.sidechain') FROM events INDEXED BY idx_events_session_ts
				WHERE session_id = ? AND kind = 'turn.assistant' AND COALESCE(agent_id,'') = '' LIMIT 1`, p.session).Scan(&side)
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return nil, err
			}
			sidechain[p.session] = side.Valid && side.Int64 == 1
		}
	}

	type key struct {
		agent string
		sub   bool
	}
	acc := map[key]*WeekAgent{}
	sessions := map[key]map[string]bool{}
	for _, p := range parts {
		k := key{agentOf[p.session], p.sub || sidechain[p.session]}
		a := acc[k]
		if a == nil {
			a = &WeekAgent{Agent: k.agent, Subagent: k.sub}
			acc[k] = a
			sessions[k] = map[string]bool{}
		}
		a.Turns += p.turns
		a.CostUSD += p.cost
		if k.sub {
			a.Threads += p.threads
		}
		sessions[k][p.session] = true
	}
	out := []WeekAgent{}
	for k, a := range acc {
		a.Sessions = int64(len(sessions[k]))
		out = append(out, *a)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].CostUSD != out[j].CostUSD {
			return out[i].CostUSD > out[j].CostUSD
		}
		return out[i].Agent+fmt.Sprint(out[i].Subagent) < out[j].Agent+fmt.Sprint(out[j].Subagent)
	})
	return out, nil
}

// ModelTokens is one model's tokens by type, which the pricing table turns
// into what each type of token cost.
type ModelTokens struct {
	Model        string
	In, Out      int64
	CacheRead    int64
	CacheWrite   int64
	CacheWrite1h int64
}

// TokensByModel sums each model's tokens by type since from.
func TokensByModel(ctx context.Context, q Querier, from int64) ([]ModelTokens, error) {
	rows, err := q.QueryContext(ctx, `
		SELECT COALESCE(model,''), COALESCE(SUM(tokens_in),0), COALESCE(SUM(tokens_out),0),
		       COALESCE(SUM(cache_read),0), COALESCE(SUM(cache_write),0), COALESCE(SUM(cache_write_1h),0)
		FROM events INDEXED BY idx_events_turn_agent
		WHERE kind = 'turn.assistant' AND ts >= ?`+nonInternalEvent+`
		GROUP BY 1`, from)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ModelTokens
	for rows.Next() {
		var m ModelTokens
		if err := rows.Scan(&m.Model, &m.In, &m.Out, &m.CacheRead, &m.CacheWrite, &m.CacheWrite1h); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// LiveSubagents counts the subagents working in a session now: each agent id
// heard from since `since` whose latest event is not its SubagentStop.
//
// Claude Code sends no event when a subagent starts, only hooks from inside it
// (they carry its agent_id) and a SubagentStop when it finishes. So a subagent
// is live from its first event until its stop, and `since` bounds how long a
// silent one is believed: one whose stop never arrived must not count forever.
func LiveSubagents(ctx context.Context, q Querier, sessionID string, since int64) (int, error) {
	var n int
	err := q.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM (
		  SELECT agent_id,
		         MAX(ts) AS last,
		         MAX(CASE WHEN kind = 'agent.stop' THEN ts ELSE 0 END) AS stopped
		  FROM events
		  WHERE session_id = ? AND ts >= ? AND COALESCE(agent_id,'') <> ''
		  GROUP BY agent_id
		) WHERE stopped < last`, sessionID, since).Scan(&n)
	return n, err
}
