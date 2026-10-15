package store

import (
	"context"
	"sort"
)

// HermesCost is what Hermes Agent's sessions cost in a range, split the two
// ways the Cost screen shows it (ADR-069): by what kind of figure it is, and
// by whether a person was there.
//
// Hermes prices its own calls and records whether a figure is the provider's
// invoice or its own estimate; the importer copies that onto each event's
// payload as `cost_basis`, and Hermes's session source as `hermes_source` and
// `background`. Nothing here is priced by Caprock's table.
type HermesCost struct {
	TotalUSD float64 `json:"total_usd"`
	// ActualUSD is what the provider reported billing; EstimatedUSD is
	// Hermes's estimate from its own price list. Subscription calls are
	// priced at zero and counted in IncludedTurns.
	ActualUSD     float64 `json:"actual_usd"`
	EstimatedUSD  float64 `json:"estimated_usd"`
	IncludedTurns int64   `json:"included_turns,omitempty"`
	// UnpricedTurns carry tokens and no cost: Hermes had no price for them.
	UnpricedTurns int64 `json:"unpriced_turns,omitempty"`
	// BackgroundUSD is the part nobody was watching as it ran — cron jobs,
	// a chat through Hermes's gateway, one-shot runs — and Sources splits it.
	BackgroundUSD float64        `json:"background_usd"`
	Sources       []HermesSource `json:"sources,omitempty"`
}

// HermesSource is the background spend of one Hermes session source.
type HermesSource struct {
	Source  string  `json:"source"`
	CostUSD float64 `json:"cost_usd"`
}

// HermesSpend sums Hermes's turns since fromMs; nil when there are none, so
// a machine without Hermes carries no empty panel.
//
// Scoped through the Hermes sessions first, so the events walked are theirs
// (idx_events_session_ts): on a machine without Hermes it reads nothing.
func HermesSpend(ctx context.Context, q Querier, fromMs int64) (*HermesCost, error) {
	rows, err := q.QueryContext(ctx, `
		SELECT COALESCE(json_extract(e.payload,'$.cost_basis'),''),
		       COALESCE(json_extract(e.payload,'$.hermes_source'),''),
		       COALESCE(json_extract(e.payload,'$.background'),0),
		       COUNT(*),
		       COALESCE(SUM(e.cost_usd),0),
		       COALESCE(SUM(CASE WHEN e.cost_usd IS NULL
		            AND COALESCE(e.tokens_in,0)+COALESCE(e.tokens_out,0)+COALESCE(e.cache_read,0)+COALESCE(e.cache_write,0) > 0
		            THEN 1 ELSE 0 END),0)
		FROM sessions s JOIN events e INDEXED BY idx_events_session_ts
		  ON e.session_id = s.session_id AND e.ts >= ?
		WHERE s.agent = 'hermes' AND e.source = 'hermes' AND e.kind = 'turn.assistant'
		  AND json_valid(e.payload) AND json_extract(e.payload,'$.cost_basis') IS NOT NULL`+nonInternalEventE+`
		GROUP BY 1, 2, 3`, fromMs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out HermesCost
	seen := false
	bySource := map[string]float64{}
	for rows.Next() {
		var basis, source string
		var background int
		var turns, unpriced int64
		var usd float64
		if err := rows.Scan(&basis, &source, &background, &turns, &usd, &unpriced); err != nil {
			return nil, err
		}
		seen = true
		out.TotalUSD += usd
		out.UnpricedTurns += unpriced
		switch basis {
		case "actual":
			out.ActualUSD += usd
		case "included":
			out.IncludedTurns += turns
		default:
			out.EstimatedUSD += usd
		}
		if background == 1 {
			out.BackgroundUSD += usd
			bySource[source] += usd
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if !seen {
		return nil, nil
	}
	for s, usd := range bySource {
		out.Sources = append(out.Sources, HermesSource{Source: s, CostUSD: usd})
	}
	sort.Slice(out.Sources, func(i, j int) bool {
		if out.Sources[i].CostUSD != out.Sources[j].CostUSD {
			return out.Sources[i].CostUSD > out.Sources[j].CostUSD
		}
		return out.Sources[i].Source < out.Sources[j].Source
	})
	return &out, nil
}
