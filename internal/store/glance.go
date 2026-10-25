package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sort"
	"time"
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
	return agentSplit(ctx, q, from, to, "")
}

// agentSplit is AgentSplit with a clause on session_id appended: the Week's
// hand-run filter (scheduledSkip).
func agentSplit(ctx context.Context, q Querier, from, to int64, skip string) ([]WeekAgent, error) {
	upper, args := "", []any{from}
	if to > 0 {
		upper, args = " AND ts < ?", append(args, to)
	}
	rows, err := q.QueryContext(ctx, `
		SELECT session_id, COALESCE(agent_id,'') <> '', COUNT(*), COALESCE(SUM(cost_usd),0), COUNT(DISTINCT NULLIF(agent_id,''))
		FROM events INDEXED BY idx_events_turn_agent
		WHERE kind = 'turn.assistant' AND ts >= ?`+upper+nonInternalEvent+skip+`
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

// SubagentTokensByModel sums, per model, the tokens of Claude Code's subagent
// turns in [from, to) that were priced: the volume "what if they ran on
// Haiku" is computed from. Turns with no stored cost are left out (an
// unpriced model, or a fork's copy of a turn paid elsewhere).
func SubagentTokensByModel(ctx context.Context, q Querier, from, to int64) ([]ModelTokens, error) {
	return SubagentTokensByModelSkip(ctx, q, from, to, "")
}

// SubagentTokensByModelSkip is SubagentTokensByModel with a clause on
// session_id appended: the Week passes its hand-run filter (Week.SkipSQL).
func SubagentTokensByModelSkip(ctx context.Context, q Querier, from, to int64, skip string) ([]ModelTokens, error) {
	rows, err := q.QueryContext(ctx, `
		SELECT COALESCE(model,''), COALESCE(SUM(tokens_in),0), COALESCE(SUM(tokens_out),0),
		       COALESCE(SUM(cache_read),0), COALESCE(SUM(cache_write),0), COALESCE(SUM(cache_write_1h),0)
		FROM events INDEXED BY idx_events_turn_agent
		WHERE kind = 'turn.assistant' AND ts >= ? AND ts < ? AND COALESCE(agent_id,'') <> '' AND cost_usd > 0`+nonInternalEvent+`
		  AND session_id IN (SELECT session_id FROM sessions WHERE COALESCE(agent,'claude') = 'claude')`+skip+`
		GROUP BY 1`, from, to)
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

// LiveSubagentWindow bounds how long a silent subagent is believed to be
// working: one whose SubagentStop never arrived must not count forever.
const LiveSubagentWindow = 30 * time.Minute

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
		  WHERE session_id = ? AND ts >= ? AND agent_id IS NOT NULL AND agent_id <> ''
		  GROUP BY agent_id
		) WHERE stopped < last`, sessionID, since).Scan(&n)
	return n, err
}

// FirstEventTs is when the first event was recorded (unix ms), or 0 with
// none: where "all time" starts.
func FirstEventTs(ctx context.Context, q Querier) (int64, error) {
	var ts int64
	err := q.QueryRowContext(ctx, `SELECT COALESCE(MIN(ts),0) FROM events WHERE 1=1`+nonInternalEvent).Scan(&ts)
	return ts, err
}

// EventsVersion is the newest event's id: it moves on every event written,
// and an answer counted at one version is still right at the same version
// unless rows were removed. Read off the primary key, so it costs one lookup.
func EventsVersion(ctx context.Context, q Querier) (int64, error) {
	var v int64
	err := q.QueryRowContext(ctx, `SELECT COALESCE(MAX(id), 0) FROM events`).Scan(&v)
	return v, err
}

// TrendWindow is what one window of the At a glance trend holds: each model's
// stored cost and tokens by type (priced into the bill by the caller), and
// tool calls by tool. The agents come from AgentSplit over the same bounds.
type TrendWindow struct {
	Models []TrendModel
	Tools  map[string]int64
}

// TrendModel is one model's stored cost and tokens by type in a window.
type TrendModel struct {
	ModelTokens
	CostUSD float64
}

// TrendWindows splits [from, now) at cut into two windows, prior = [from, cut)
// and recent = [cut, now), with one grouped query for the turns and one for
// the tool calls: the window is a GROUP BY column, so the two windows cost
// one range scan each, on the same covering indexes the all-time figures read
// (idx_events_turn_agent, idx_events_tool_dist).
func TrendWindows(ctx context.Context, q Querier, from, cut int64) (prior, recent TrendWindow, err error) {
	prior.Tools, recent.Tools = map[string]int64{}, map[string]int64{}
	pick := func(isRecent bool) *TrendWindow {
		if isRecent {
			return &recent
		}
		return &prior
	}
	rows, err := q.QueryContext(ctx, `
		SELECT ts >= ?, COALESCE(model,''), COALESCE(SUM(cost_usd),0),
		       COALESCE(SUM(tokens_in),0), COALESCE(SUM(tokens_out),0),
		       COALESCE(SUM(cache_read),0), COALESCE(SUM(cache_write),0), COALESCE(SUM(cache_write_1h),0)
		FROM events INDEXED BY idx_events_turn_agent
		WHERE kind = 'turn.assistant' AND ts >= ?`+nonInternalEvent+`
		GROUP BY 1, 2`, cut, from)
	if err != nil {
		return prior, recent, err
	}
	for rows.Next() {
		var isRecent bool
		var m TrendModel
		if err := rows.Scan(&isRecent, &m.Model, &m.CostUSD, &m.In, &m.Out, &m.CacheRead, &m.CacheWrite, &m.CacheWrite1h); err != nil {
			_ = rows.Close()
			return prior, recent, err
		}
		w := pick(isRecent)
		w.Models = append(w.Models, m)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return prior, recent, err
	}
	_ = rows.Close()
	// The same calls ToolDistribution counts for history's Most-used tools.
	rows, err = q.QueryContext(ctx, `
		SELECT ts >= ?, tool, COUNT(*)
		FROM events
		WHERE kind = 'tool.pre' AND tool != '' AND ts >= ? AND internal = 0
		GROUP BY 1, 2`, cut, from)
	if err != nil {
		return prior, recent, err
	}
	defer rows.Close()
	for rows.Next() {
		var isRecent bool
		var tool string
		var n int64
		if err := rows.Scan(&isRecent, &tool, &n); err != nil {
			return prior, recent, err
		}
		pick(isRecent).Tools[tool] += n
	}
	return prior, recent, rows.Err()
}
