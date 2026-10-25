package store

import (
	"context"
	"sort"
)

// SpendPart is the share of a cost that ran on one sign-in: an agent and the
// subscription its sessions recorded ("" the user's own sign-in, ADR-048).
// A figure carries its parts so a plan figure can be priced by the plan each
// part ran on (internal/planshare): a pull request worked on from two
// subscriptions is two parts, each at its own plan's rate.
type SpendPart struct {
	Agent        string  `json:"agent"`
	Subscription string  `json:"subscription"`
	CostUSD      float64 `json:"cost_usd"`
}

// SpendParts is a cost split by sign-in, at most one entry per (agent,
// subscription), dearest first once Sorted.
type SpendParts []SpendPart

// Add puts cost on (agent, subscription), and returns the parts. A zero or
// negative cost changes nothing.
func (p SpendParts) Add(agent, subscription string, cost float64) SpendParts {
	if cost <= 0 {
		return p
	}
	if agent == "" {
		agent = "claude"
	}
	for i := range p {
		if p[i].Agent == agent && p[i].Subscription == subscription {
			p[i].CostUSD += cost
			return p
		}
	}
	return append(p, SpendPart{Agent: agent, Subscription: subscription, CostUSD: cost})
}

// Merge adds every part of o, and returns the parts.
func (p SpendParts) Merge(o SpendParts) SpendParts {
	for _, x := range o {
		p = p.Add(x.Agent, x.Subscription, x.CostUSD)
	}
	return p
}

// Sorted orders the parts dearest first (then by agent and subscription, so
// an answer is stable), in place, and returns them.
func (p SpendParts) Sorted() SpendParts {
	sort.Slice(p, func(i, j int) bool {
		if p[i].CostUSD != p[j].CostUSD {
			return p[i].CostUSD > p[j].CostUSD
		}
		if p[i].Agent != p[j].Agent {
			return p[i].Agent < p[j].Agent
		}
		return p[i].Subscription < p[j].Subscription
	})
	return p
}

// SpendPartsBetween is the priced work in [fromMs, toMs) by agent and
// subscription — the Cost screen's total split by sign-in, and the plan
// figures' denominators (internal/planshare). toMs <= 0 means no upper bound.
// Every kind's cost counts, internal turns excepted, the same scope as the
// summary's cost_usd; spend whose session row is gone is the own sign-in's
// Claude Code, which is what a session recorded before ADR-048 was.
//
// One covering range scan (idx_events_ts_cover) joined to sessions: 0.5 s
// for 30 days and 1.0 s for all time on a 2.2 GB copy of the owner's
// database, in the sqlite shell (2026-10-25), so its callers cache it.
func SpendPartsBetween(ctx context.Context, q Querier, fromMs, toMs int64, agent AgentFilter) (SpendParts, error) {
	ev, evArgs := agent.sessionScope("e.session_id")
	upper, upperArgs := "", []any(nil)
	if toMs > 0 {
		upper, upperArgs = " AND e.ts < ?", []any{toMs}
	}
	args := append([]any{fromMs}, upperArgs...)
	args = append(args, evArgs...)
	rows, err := q.QueryContext(ctx, `
		SELECT COALESCE(NULLIF(s.agent,''),'claude'), COALESCE(s.subscription,''), COALESCE(SUM(e.cost_usd),0)
		FROM events e INDEXED BY idx_events_ts_cover
		LEFT JOIN sessions s ON s.session_id = e.session_id
		WHERE e.ts >= ?`+upper+` AND e.internal = 0 AND e.cost_usd > 0`+ev+`
		GROUP BY 1, 2`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out SpendParts
	for rows.Next() {
		var a, sub string
		var c float64
		if err := rows.Scan(&a, &sub, &c); err != nil {
			return nil, err
		}
		out = out.Add(a, sub, c)
	}
	return out.Sorted(), rows.Err()
}

// SpendOn is the priced work of one sign-in in [fromMs, toMs): agent and
// subscription as sessions record them. The weekly calibration's spend.
func SpendOn(ctx context.Context, q Querier, agent, subscription string, fromMs, toMs int64) (float64, error) {
	var c float64
	err := q.QueryRowContext(ctx, `
		SELECT COALESCE(SUM(e.cost_usd),0)
		FROM events e INDEXED BY idx_events_ts_cover
		JOIN sessions s ON s.session_id = e.session_id
		WHERE e.ts >= ? AND e.ts < ? AND e.internal = 0 AND e.cost_usd > 0
		  AND COALESCE(NULLIF(s.agent,''),'claude') = ? AND COALESCE(s.subscription,'') = ?`,
		fromMs, toMs, agent, subscription).Scan(&c)
	return c, err
}

// FirstSessionBySignIn is when each (agent, subscription) first started a
// session (unix ms), keyed "agent|subscription": how much of a trailing
// period a sign-in has been recorded for.
func FirstSessionBySignIn(ctx context.Context, q Querier) (map[string]int64, error) {
	rows, err := q.QueryContext(ctx, `
		SELECT COALESCE(NULLIF(agent,''),'claude'), COALESCE(subscription,''), MIN(started_at)
		FROM sessions WHERE started_at > 0 GROUP BY 1, 2`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]int64{}
	for rows.Next() {
		var a, sub string
		var at int64
		if err := rows.Scan(&a, &sub, &at); err != nil {
			return nil, err
		}
		out[a+"|"+sub] = at
	}
	return out, rows.Err()
}

// RateLimitSamples is every kept sample of one plan window (the history, and
// the latest row, which is newer than the history's newest when the
// throttle skipped it), oldest first, from sinceMs on.
func RateLimitSamples(ctx context.Context, q Querier, window string, sinceMs int64) ([]RateLimitSnapshot, error) {
	rows, err := q.QueryContext(ctx, `
		SELECT ts, used_percentage, resets_at FROM rate_limit_history WHERE window = ? AND ts >= ?
		UNION
		SELECT ts, used_percentage, resets_at FROM rate_limit_latest WHERE window = ? AND ts >= ?
		ORDER BY 1`, window, sinceMs, window, sinceMs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []RateLimitSnapshot
	for rows.Next() {
		s := RateLimitSnapshot{Window: window}
		if err := rows.Scan(&s.Ts, &s.UsedPercentage, &s.ResetsAt); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}
