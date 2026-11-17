package contexttax

import (
	"testing"

	"github.com/dspv/caprock/internal/cost"
)

// A model priced by prompt length charges a call at the tier its context falls
// in: Haiku 5.5 reads cache at $0.01 per 1M up to 100,000 tokens and $0.05
// above. The per-call figures — the next call, a loop's tax and its full cost
// — choose the tier from each call's own context.
func TestCallsArePricedAtTheirContextsTier(t *testing.T) {
	haiku := cost.Model{Input: 0.10, CacheRead: 0.01, CacheWrite5m: 0.125,
		Tiers: []cost.Tier{{AbovePromptTokens: 100_000, Input: 0.50, CacheRead: 0.05, CacheWrite5m: 0.625}}}
	p := PricesOf(haiku)
	close(t, NextCall(100_000, p), 100_000*0.01/perMTok)
	close(t, NextCall(200_000, p), 200_000*0.05/perMTok)

	small := Call{Context: 50_000, Result: 1_000, TurnsLeft: 2}
	big := Call{Context: 150_000, Result: 1_000, TurnsLeft: 2}
	close(t, small.Tax(p), 50_000*0.01/perMTok)
	close(t, big.Tax(p), 150_000*0.05/perMTok)
	close(t, big.Cost(p), (150_000*0.05+1_000*0.625+1_000*2*0.05)/perMTok)
	close(t, TaxOf([]Call{small, big}, p), (50_000*0.01+150_000*0.05)/perMTok)

	// A model with no tiers is unchanged.
	close(t, NextCall(500_000, PricesOf(opus)), 500_000*1.50/perMTok)
}
