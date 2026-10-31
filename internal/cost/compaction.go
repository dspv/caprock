package cost

import "time"

// The compaction estimate (ADR-085 as amended 2026-10-30; 03-contracts.md §
// Compaction stats DDL). Claude Code's transcript has no usage for the call
// that writes a compaction's summary, so its cost is estimated from the
// sizes the boundary records; and what a compaction saves is the context it
// dropped, which every later call would otherwise have read from the cache.
// Both are estimates, labelled as such wherever they are shown (rule 6).

// Prompt cache lifetimes: a cached prefix not read again within its TTL is
// gone. Claude Code writes the 5-minute cache unless the session writes the
// 1-hour one (cache_creation.ephemeral_1h_input_tokens above zero).
const (
	CacheTTL5m = 5 * time.Minute
	CacheTTL1h = time.Hour
)

// CompactionCost is the estimated cost of the call that summarised pre
// tokens of context into summaryTokens of output, at model's prices at `at`:
// the context read from the cache when it was warm, sent as uncached input
// when it was not, and the summary as output. ok is false when the model is
// not in the table.
func (t *Table) CompactionCost(model string, at time.Time, pre, summaryTokens int64, warm bool) (float64, bool) {
	row, ok := t.LookupAt(model, at)
	if !ok {
		return 0, false
	}
	in := row.Input
	if warm {
		in = row.CacheRead
	}
	return (float64(max(pre, 0))*in + float64(max(summaryTokens, 0))*row.Output) / perMTok, true
}

// CompactionSaving is what one call after a compaction did not pay for the
// dropped tokens it would otherwise have read from the cache, at the call's
// own model and time. ok is false when the model is not in the table.
func (t *Table) CompactionSaving(model string, at time.Time, dropped int64) (float64, bool) {
	if dropped <= 0 {
		return 0, true
	}
	row, ok := t.LookupAt(model, at)
	if !ok {
		return 0, false
	}
	return float64(dropped) * row.CacheRead / perMTok, true
}
