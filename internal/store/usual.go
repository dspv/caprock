package store

import (
	"context"
	"sort"
)

// Usual is what this machine's own history says is typical, so the cockpit
// can set a session's headline against it ("▲ 38%"). Every figure is
// measured here over the last UsualDays; nothing comes from elsewhere
// (rule 6). A distribution with too few samples is left out rather than
// drawn from a handful: a new user sees nothing, never a guess.
type Usual struct {
	// Days is the window the figures cover.
	Days int `json:"days"`
	// Burn is dollars per active session-hour: every clock hour in which
	// one session made at least UsualMinCalls priced calls costing more
	// than nothing, its spend in that hour. A session's hour, not the
	// machine's: four sessions at once are not one burning four times as
	// fast.
	Burn *Deciles `json:"burn,omitempty"`
	// Cost and Tokens are every session's total over the window (tokens:
	// input with cache reads and writes, as the cockpit counts them).
	Cost   *Deciles `json:"cost,omitempty"`
	Tokens *Deciles `json:"tokens,omitempty"`
	// Cache is the window's cache hit rate, 0..100; nil with no input.
	Cache *float64 `json:"cache,omitempty"`
}

// Deciles is a distribution as its sample count and eleven values: the
// minimum, every tenth percentile, and the maximum, ascending; and its mean.
// The cockpit's chart needs the mean: a bar's burn rate is its active hours'
// cost over those hours, a mean, and a mean set against a median of a
// skewed distribution reads high every time (the owner's 30 days on
// 2026-10-13: median $3.82/h, mean $8.25/h).
type Deciles struct {
	N    int       `json:"n"`
	Q    []float64 `json:"q"`
	Mean float64   `json:"mean"`
}

const (
	// UsualDays is the window the usual is measured over.
	UsualDays = 30
	// UsualMinCalls is how many priced calls make a session-hour active:
	// fewer is a session touched in passing, whose hour would drag the
	// median down without being a rate anyone worked at.
	UsualMinCalls = 5
	// UsualMinHours and UsualMinSessions are the samples below which a
	// distribution is not given at all.
	UsualMinHours    = 20
	UsualMinSessions = 8
)

// deciles returns the eleven nearest-rank deciles of v, which it sorts; nil
// when v has fewer than min values.
func deciles(v []float64, min int) *Deciles {
	if len(v) < min || len(v) == 0 {
		return nil
	}
	sort.Float64s(v)
	q := make([]float64, 11)
	for k := range q {
		q[k] = v[k*(len(v)-1)/10]
	}
	var sum float64
	for _, x := range v {
		sum += x
	}
	return &Deciles{N: len(v), Q: q, Mean: sum / float64(len(v))}
}

// UsualSince measures the usual from fromMs on, through the agent filter.
// One grouped scan of the priced assistant turns, per (session, clock hour),
// off the covering index the summary already uses (idx_events_turn_agent):
// on the owner's 1.7 GB copy, 0.02s warm and 0.12s cold for 30 days
// (2026-10-13). Session totals are the same rows summed in Go.
func UsualSince(ctx context.Context, q Querier, fromMs int64, agent AgentFilter) (*Usual, error) {
	scope, args := agent.sessionScope("session_id")
	rows, err := q.QueryContext(ctx, `
		SELECT session_id, ts / 3600000 AS h,
		       COALESCE(SUM(cost_usd), 0), COUNT(cost_usd),
		       COALESCE(SUM(COALESCE(tokens_in,0)), 0), COALESCE(SUM(COALESCE(cache_read,0)), 0), COALESCE(SUM(COALESCE(cache_write,0)), 0)
		FROM events
		WHERE kind = 'turn.assistant' AND ts >= ?`+nonInternalEvent+scope+`
		GROUP BY session_id, h`, append([]any{fromMs}, args...)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	type total struct {
		cost   float64
		tokens int64
	}
	var hours []float64
	sessions := map[string]*total{}
	var in, cr, cw int64
	for rows.Next() {
		var sid string
		var h, n, tin, tcr, tcw int64
		var c float64
		if err := rows.Scan(&sid, &h, &c, &n, &tin, &tcr, &tcw); err != nil {
			return nil, err
		}
		if n >= UsualMinCalls && c > 0 {
			hours = append(hours, c)
		}
		t := sessions[sid]
		if t == nil {
			t = &total{}
			sessions[sid] = t
		}
		t.cost += c
		t.tokens += tin + tcr + tcw
		in, cr, cw = in+tin, cr+tcr, cw+tcw
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	var costs, tokens []float64
	for _, t := range sessions {
		if t.cost > 0 {
			costs = append(costs, t.cost)
			tokens = append(tokens, float64(t.tokens))
		}
	}
	u := &Usual{Days: UsualDays, Burn: deciles(hours, UsualMinHours), Cost: deciles(costs, UsualMinSessions), Tokens: deciles(tokens, UsualMinSessions)}
	// The cache rate is a usual only across sessions: one session's rate
	// set against itself says nothing.
	if d := in + cr + cw; d > 0 && len(costs) >= UsualMinSessions {
		rate := float64(cr) / float64(d) * 100
		u.Cache = &rate
	}
	if u.Burn == nil && u.Cost == nil && u.Tokens == nil && u.Cache == nil {
		return nil, nil
	}
	return u, nil
}
