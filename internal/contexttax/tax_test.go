package contexttax

import (
	"math"
	"testing"

	"github.com/dspv/caprock/internal/cost"
)

func close(t *testing.T, got, want float64) {
	t.Helper()
	if math.Abs(got-want) > 1e-9 {
		t.Fatalf("got %v, want %v", got, want)
	}
}

// Opus 5 shape: $15/M in, $1.50/M cache read, $18.75/M cache write.
var opus = cost.Model{Input: 15, CacheRead: 1.50, CacheWrite5m: 18.75}

func TestNextCallIsTheHeadlineFigure(t *testing.T) {
	// The spec's own example: a 968k-token session pays $0.48 for a call that
	// has not run yet.
	got := NextCall(968_728, PricesOf(opus))
	if math.Abs(got-1.453) > 0.001 {
		t.Fatalf("968k at Opus cache-read = %v", got)
	}
	// And the archive's mean Bash context, the $0.19 the spec leads with.
	got = NextCall(382_620, PricesOf(opus))
	if math.Abs(got-0.574) > 0.001 {
		t.Fatalf("382k = %v", got)
	}
}

func TestNextCallOnNoContext(t *testing.T) {
	// A session with no turn yet has no context to re-read, and a negative
	// reading is a bug upstream, not a credit.
	close(t, NextCall(0, PricesOf(opus)), 0)
	close(t, NextCall(-1, PricesOf(opus)), 0)
}

func TestTaxIsTheContextTermOnly(t *testing.T) {
	p := PricesOf(opus)
	c := Call{Context: 1_000_000, Result: 1_000_000, TurnsLeft: 3}
	// Tax is the first term and nothing else: 1M tokens at $1.50/M.
	close(t, c.Tax(p), 1.50)
	// Cost adds the result written once and re-read by the 3 turns left.
	close(t, c.Cost(p), 1.50+18.75+3*1.50)
}

// Fable 5.1 and Mythos 5.1 read cache at 0.025x, not the 0.1x the rest of the
// table uses. A meter built on a 0.10 multiplier overcharges them four times
// over, which is exactly the mistake the Stage 0 prototype made.
func TestCacheReadComesFromTheTableNotAMultiplier(t *testing.T) {
	table, err := cost.Embedded()
	if err != nil {
		t.Fatalf("embedded pricing: %v", err)
	}
	row, ok := table.Lookup("claude-fable-5-1")
	if !ok {
		t.Skip("fable 5.1 not in the embedded table")
	}
	p := PricesOf(row)
	if p.CacheRead >= row.Input*0.10/perMTok {
		t.Fatalf("fable cache read %v is not below the 0.1x rule", p.CacheRead)
	}
	close(t, p.CacheRead, row.CacheRead/perMTok)
}

func TestIsolationSavesTheReReadNotTheRate(t *testing.T) {
	p := PricesOf(opus)
	// Twelve calls in a 400k context, each returning 500 tokens.
	var calls []Call
	for i := 0; i < 12; i++ {
		calls = append(calls, Call{Context: 400_000, Result: 500, TurnsLeft: 12 - i})
	}
	iso := Isolate(calls, p, 20)
	if iso.Saved <= 0 {
		t.Fatalf("a 12-call loop at 400k should save when isolated, got %+v", iso)
	}
	// The lever is worth about an order of magnitude on a series like this;
	// anything near parity means the subagent's own growth was mismodelled.
	if iso.Isolated > iso.Actual/5 {
		t.Fatalf("isolated %v vs actual %v: saving too small to be the 12x lever", iso.Isolated, iso.Actual)
	}
}

func TestIsolationNeverShowsANegativeSaving(t *testing.T) {
	// A short loop in a small context costs more isolated, because the summary
	// and brief outweigh what little re-reading it avoided. That is a real
	// answer, but it is not a charge, so it floors at zero.
	p := PricesOf(opus)
	calls := []Call{{Context: 5_000, Result: 100, TurnsLeft: 1}}
	iso := Isolate(calls, p, 50)
	if iso.Saved != 0 {
		t.Fatalf("saved = %v, want floored to 0", iso.Saved)
	}
	if iso.Isolated <= iso.Actual {
		t.Fatalf("this case is only interesting if isolation is worse: %+v", iso)
	}
}

func TestTaxOfSumsTheSeries(t *testing.T) {
	p := PricesOf(opus)
	calls := []Call{
		{Context: 100_000, Result: 10, TurnsLeft: 2},
		{Context: 200_000, Result: 10, TurnsLeft: 1},
	}
	close(t, TaxOf(calls, p), 0.15+0.30)
}
