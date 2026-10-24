package store

import "context"

// SubscriptionSpend is one subscription's work since a moment (ADR-048).
type SubscriptionSpend struct {
	Agent        string
	Subscription string // "" is the Default sign-in
	Sessions     int64
	CostUSD      float64
}

// SpendBySubscription sums the priced turns since `since` (unix ms) per agent
// and subscription, for Settings → Subscriptions. Only agents that have
// subscriptions are asked for; internal turns (the agent's own housekeeping
// calls) are left out, as everywhere else a cost is shown.
func SpendBySubscription(ctx context.Context, q Querier, since int64) ([]SubscriptionSpend, error) {
	rows, err := q.QueryContext(ctx, `
		SELECT COALESCE(s.agent, 'claude'), s.subscription, COUNT(DISTINCT e.sid), COALESCE(SUM(e.cost_usd), 0)
		FROM events e JOIN sessions s ON s.sid = e.sid
		WHERE e.kind = 'turn.assistant' AND e.ts >= ? AND e.internal = 0
		  AND COALESCE(s.agent, 'claude') IN ('claude', 'codex')
		GROUP BY 1, 2`, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SubscriptionSpend
	for rows.Next() {
		var r SubscriptionSpend
		if err := rows.Scan(&r.Agent, &r.Subscription, &r.Sessions, &r.CostUSD); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
