package api

import (
	"sort"
	"strings"

	"github.com/dspv/caprock/internal/cost"
	"github.com/dspv/caprock/internal/store"
)

// SubagentSaving is the honest hint beside the week's subagent spend: what the
// subagents that ran on a pricier model than Haiku cost at list prices, and
// what the same tokens would cost on Haiku. An estimate: Haiku is not a
// drop-in for every task, its answers and its token counts differ, and a
// prompt over a tier boundary is priced at the row's lower tier. Contract:
// .ai/03-contracts.md § Subagent saving.
type SubagentSaving struct {
	// Models are the pricier models' display names, dearest spend first.
	Models []string `json:"models"`
	// CostUSD is those models' subagent tokens at the pricing table's rates.
	CostUSD float64 `json:"cost_usd"`
	// HaikuUSD is the same tokens at Haiku's rates; Haiku is its display name.
	HaikuUSD float64 `json:"haiku_usd"`
	Haiku    string  `json:"haiku"`
}

// minSubagentSaving is the smallest difference worth saying: below a dollar the
// hint is noise.
const minSubagentSaving = 1.0

// latestHaiku is the newest current Haiku row of the table, by id.
func latestHaiku(t *cost.Table) (cost.Model, bool) {
	var best cost.Model
	found := false
	for _, m := range t.Models {
		if !strings.HasPrefix(m.ID, "claude-haiku-") || m.Until != "" {
			continue
		}
		if !found || m.ID > best.ID {
			best, found = m, true
		}
	}
	return best, found
}

func tokenCost(row cost.Model, m store.ModelTokens) float64 {
	cw5m := m.CacheWrite - m.CacheWrite1h
	if cw5m < 0 {
		cw5m = 0
	}
	return (float64(m.In)*row.Input + float64(m.Out)*row.Output + float64(m.CacheRead)*row.CacheRead +
		float64(cw5m)*row.CacheWrite5m + float64(m.CacheWrite1h)*row.CacheWrite1h) / 1_000_000
}

// subagentSaving prices the subagent tokens of every model that costs more
// than Haiku on both ways; nil when there is no table or no Haiku row, when no
// subagent ran on a pricier model, or when the difference is under a dollar.
func subagentSaving(toks []store.ModelTokens, t *cost.Table) *SubagentSaving {
	if t == nil {
		return nil
	}
	haiku, ok := latestHaiku(t)
	if !ok {
		return nil
	}
	type part struct {
		name string
		usd  float64
	}
	var parts []part
	out := &SubagentSaving{Haiku: strings.TrimPrefix(haiku.Display, "Claude ")}
	for _, m := range toks {
		row, ok := t.Lookup(m.Model)
		if !ok {
			continue
		}
		own, onHaiku := tokenCost(row, m), tokenCost(haiku, m)
		if own <= onHaiku {
			continue // already as cheap as Haiku, or cheaper
		}
		out.CostUSD += own
		out.HaikuUSD += onHaiku
		name := strings.TrimPrefix(row.Display, "Claude ")
		if name == "" {
			name = m.Model
		}
		parts = append(parts, part{name, own})
	}
	if out.CostUSD-out.HaikuUSD < minSubagentSaving {
		return nil
	}
	sort.SliceStable(parts, func(i, j int) bool { return parts[i].usd > parts[j].usd })
	seen := map[string]bool{}
	for _, p := range parts {
		if !seen[p.name] {
			seen[p.name] = true
			out.Models = append(out.Models, p.name)
		}
	}
	return out
}
