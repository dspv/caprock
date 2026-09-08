// Package contexttax prices what a session pays to re-send its own context.
//
// Every tool call re-reads the whole conversation as a cache read before it
// does anything. At 382k tokens that is about $0.19 a call on Opus 5, and a
// loop of twelve pays it twelve times. That charge is the context tax, and
// until now Caprock stored every number needed to compute it and showed none
// of them.
//
// The formulas are spec/spec-context-tax.md section 5. Prices come from the
// pricing table rather than from multipliers on the input price: Fable 5.1 and
// Mythos 5.1 read cache at 0.025x, not the 0.1x the rest of the table uses.
package contexttax

import "github.com/dspv/caprock/internal/cost"

const perMTok = 1_000_000.0

// Prices are the per-token rates a series is charged at, already divided out
// of the table's per-million figures.
type Prices struct {
	CacheRead  float64
	CacheWrite float64
}

// PricesOf reads the rates for a model out of a pricing row.
//
// CacheWrite5m is the right write rate: a series writes results it re-reads
// within the same loop, which is minutes, not the hour the 1h rate is for.
func PricesOf(row cost.Model) Prices {
	return Prices{
		CacheRead:  row.CacheRead / perMTok,
		CacheWrite: row.CacheWrite5m / perMTok,
	}
}

// NextCall is what the next tool call costs at the current context, before it
// does any work. It is the meter's sharpest number: on a 968k-token session it
// reads $0.48 for a call that has not run yet.
func NextCall(contextTokens int64, p Prices) float64 {
	if contextTokens <= 0 {
		return 0
	}
	return float64(contextTokens) * p.CacheRead
}

// Call is one priced tool call: the context it re-read, what it returned, and
// how many assistant turns still followed it in the session.
type Call struct {
	Context   int64
	Result    int64
	TurnsLeft int
}

// Tax is the first term of section 5.2 — the context this call re-read, and
// nothing else. It is the number the meter shows, kept apart from the cost of
// the result so a reader can see which half is which.
func (c Call) Tax(p Prices) float64 {
	return float64(c.Context) * p.CacheRead
}

// Cost is the full section 5.2 charge for a call: the context it re-read, the
// result it wrote to cache, and that result being re-read by every turn left
// in the session.
func (c Call) Cost(p Prices) float64 {
	return c.Tax(p) +
		float64(c.Result)*p.CacheWrite +
		float64(c.Result)*float64(c.TurnsLeft)*p.CacheRead
}

// TaxOf sums the context tax over a run of calls.
func TaxOf(calls []Call, p Prices) float64 {
	var sum float64
	for _, c := range calls {
		sum += c.Tax(p)
	}
	return sum
}

// CostOf sums the full charge over a run of calls.
func CostOf(calls []Call, p Prices) float64 {
	var sum float64
	for _, c := range calls {
		sum += c.Cost(p)
	}
	return sum
}

// Lifetime is the context tax over a range, and what share of the spend it is.
//
// Share is against the spend actually priced, so a workload with unpriced
// models reports a share of what it could price rather than a share diluted by
// what it could not. Unpriced volume is already reported separately.
type Lifetime struct {
	TaxUSD  float64 `json:"tax_usd"`
	CostUSD float64 `json:"cost_usd"`
	Share   float64 `json:"share"`
	// Unpriced is how many cache-read tokens belong to models with no pricing
	// row, so the tax above excludes them. A tax figure that silently dropped
	// them would understate itself with no way for a reader to tell.
	UnpricedTokens int64 `json:"unpriced_tokens,omitempty"`
}

// ModelTax is one model's re-read volume, the shape Lifetime sums over.
type ModelTax struct {
	Model     string
	CacheRead int64
	CostUSD   float64
}

// Table is the subset of the pricing table this package needs, so callers can
// pass the real one without this package importing the daemon.
//
// Lookup, not LookupAt: an aggregate over a range has no single instant to
// price at. Where a model's rate changed inside the range -- Sonnet 5 went
// from $0.20 to $0.30 per million cache-read tokens on 2026-08-30 -- the
// lifetime tax is charged at today's rate for that model's whole volume. The
// error is bounded by how much a rate moved and applies only to the models
// that moved; per-call figures, where an instant does exist, use LookupAt.
type Table interface {
	Lookup(model string) (cost.Model, bool)
}

// Sum prices each model's re-read volume at that model's own cache-read rate.
//
// Per model, not blended: Fable 5.1 and Mythos 5.1 read cache at 0.025x while
// the rest of the table reads at 0.1x, so a single rate would misprice any
// mixed workload by up to four times.
func Sum(models []ModelTax, t Table) Lifetime {
	var lt Lifetime
	for _, m := range models {
		lt.CostUSD += m.CostUSD
		row, ok := t.Lookup(m.Model)
		if !ok {
			lt.UnpricedTokens += m.CacheRead
			continue
		}
		lt.TaxUSD += float64(m.CacheRead) * PricesOf(row).CacheRead
	}
	if lt.CostUSD > 0 {
		lt.Share = 100 * lt.TaxUSD / lt.CostUSD
	}
	return lt
}
