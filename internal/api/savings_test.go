package api

import (
	"math"
	"testing"

	"github.com/dspv/caprock/internal/cost"
	"github.com/dspv/caprock/internal/store"
)

// A range's savings weigh each model's cache at that model's own rates
// (#1113): Opus 5.5 reads at 0.05x of input, Haiku 4.5 at 0.10x. What the
// model rows do not account for (another kind of event's tokens) falls back
// to 0.10/1.25.
func TestSummarySavingsWeighEachModel(t *testing.T) {
	tb, err := cost.Embedded()
	if err != nil {
		t.Fatal(err)
	}
	sum := store.Summary{TokensIn: 1_000, CacheRead: 3_100_000, CacheWrite: 40_000, Models: []store.ModelShare{
		{Model: "claude-opus-5-5", CacheRead: 2_000_000, CacheWrite: 30_000},
		{Model: "claude-haiku-4-5", CacheRead: 1_000_000, CacheWrite: 10_000},
	}}
	got := summarySavings(tb, sum)
	want := 1_000 + 0.05*2_000_000 + 1.25*30_000 + 0.10*1_000_000 + 1.25*10_000 + 0.10*100_000
	if math.Abs(got.BilledWith-want) > 1e-6 {
		t.Fatalf("billed_with %v, want %v", got.BilledWith, want)
	}
	if got.BilledWithout != 1_000+3_100_000+40_000 {
		t.Fatalf("billed_without %v", got.BilledWithout)
	}
	// No table: the fixed weights, as before.
	if old := summarySavings(nil, sum); old != cost.ComputeSavings(sum.TokensIn, sum.CacheRead, sum.CacheWrite) {
		t.Fatalf("nil table: %+v", old)
	}
}
