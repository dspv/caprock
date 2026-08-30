package cost

import (
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
)

func TestEmbeddedParses(t *testing.T) {
	tb, err := Embedded()
	if err != nil {
		t.Fatal(err)
	}
	if tb.Version == "" || tb.Source == "" || tb.FetchedAt == "" {
		t.Fatalf("embedded table missing provenance: %+v", tb)
	}
	if _, ok := tb.Lookup("claude-opus-5"); !ok {
		t.Fatal("claude-opus-5 not found")
	}
}

func TestLookupPrefixAndProviderIDs(t *testing.T) {
	tb, _ := Embedded()
	cases := map[string]string{
		"claude-opus-5":                                "claude-opus-5",
		"claude-sonnet-4-5-20250929":                   "claude-sonnet-4-5",
		"us.anthropic.claude-sonnet-4-5-20250929-v1:0": "claude-sonnet-4-5",
		"claude-opus-4-5@20251101":                     "claude-opus-4-5",
		"claude-3-5-haiku-20241022":                    "claude-3-5-haiku",
		"CLAUDE-HAIKU-4-5":                             "claude-haiku-4-5",
		"anthropic.claude-opus-4-1-20250805-v1:0":      "claude-opus-4-1",
	}
	for in, want := range cases {
		row, ok := tb.Lookup(in)
		if !ok || row.ID != want {
			t.Errorf("Lookup(%q) = %q,%v; want %q", in, row.ID, ok, want)
		}
	}
	if _, ok := tb.Lookup("gpt-5"); ok {
		t.Error("unknown model matched")
	}
	if _, ok := tb.Lookup(""); ok {
		t.Error("empty model matched")
	}
	// "claude-opus-4" must not swallow "claude-opus-4-8".
	if row, _ := tb.Lookup("claude-opus-4-8"); row.ID != "claude-opus-4-8" {
		t.Errorf("longest prefix not preferred: %s", row.ID)
	}
}

func TestPriceArithmetic(t *testing.T) {
	tb, _ := Embedded()
	// Claude Opus 5: $5 in, $6.25 5m write, $10 1h write, $0.50 read, $25 out (per MTok).
	usd, ok := tb.Price("claude-opus-5", event.TokenDelta{In: 1_000_000, Out: 1_000_000, CacheRead: 1_000_000, CacheWrite: 1_000_000})
	if !ok || math.Abs(usd-(5+25+0.5+6.25)) > 1e-9 {
		t.Fatalf("got %v", usd)
	}
	// 1h split: 400k of the 1M writes at 1h rate.
	usd, _ = tb.Price("claude-opus-5", event.TokenDelta{CacheWrite: 1_000_000, CacheWrite1h: 400_000})
	if math.Abs(usd-(0.6*6.25+0.4*10)) > 1e-9 {
		t.Fatalf("1h split: got %v", usd)
	}
	if _, ok := tb.Price("unknown", event.TokenDelta{In: 10}); ok {
		t.Fatal("unknown model priced")
	}
}

func TestSavingsFormulaMatchesLegacy(t *testing.T) {
	// From caprock-legacy _savings.py: in=2, cache_write=17332, cache_read=20589.
	s := ComputeSavings(2, 20589, 17332)
	wantWith := 2 + 1.25*17332 + 0.10*20589
	wantWithout := float64(2 + 17332 + 20589)
	if math.Abs(s.BilledWith-wantWith) > 1e-9 || math.Abs(s.BilledWithout-wantWithout) > 1e-9 || math.Abs(s.Saved-(wantWithout-wantWith)) > 1e-9 {
		t.Fatalf("savings mismatch: %+v", s)
	}
	if s.HitRate <= 0.5 || s.HitRate >= 0.55 {
		t.Fatalf("hit rate %v", s.HitRate)
	}
	z := ComputeSavings(0, 0, 0)
	if z.HitRate != 0 || z.CutPct != 0 || z.Saved != 0 {
		t.Fatalf("zero case: %+v", z)
	}
}

func TestLoadOverride(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "pricing.json")
	tb, err := Load(p) // absent → embedded
	if err != nil || tb.UserOverride {
		t.Fatalf("absent override: %v %v", tb.UserOverride, err)
	}
	_ = os.WriteFile(p, []byte(`{"version":"me.1","models":[{"id":"claude-opus-5","input":1,"output":1}]}`), 0o600)
	tb, err = Load(p)
	if err != nil || !tb.UserOverride || tb.Version != "me.1" {
		t.Fatalf("override: %+v %v", tb, err)
	}
	_ = os.WriteFile(p, []byte(`{"version":"broken"`), 0o600)
	if _, err := Load(p); err == nil {
		t.Fatal("broken override must error, not fall back silently")
	}
}

// The same model reported by two routes must price the same.
//
// OpenRouter says "minimax/minimax-m3"; a direct MiniMax API says "MiniMax-M3".
// Before the vendor prefix was stripped, the owner's own database held four
// spellings of MiniMax and 38 turns nobody could cost — usage that had been
// paid for and could not appear in a total.
func TestGatewayPrefixesPriceTheSame(t *testing.T) {
	tab, err := Load("../../pricing/pricing.json")
	if err != nil {
		t.Fatal(err)
	}
	for _, group := range [][]string{
		{"minimax-m3", "MiniMax-M3", "minimax/minimax-m3", "MiniMax-M3-Preview"},
		{"deepseek-v4-pro", "deepseek/deepseek-v4-pro"},
	} {
		var want Model
		for i, id := range group {
			got, ok := tab.Lookup(id)
			if !ok {
				t.Errorf("%q has no price", id)
				continue
			}
			if i == 0 {
				want = got
				continue
			}
			if got.ID != want.ID {
				t.Errorf("%q priced as %q, but %q priced as %q — same model, two rows",
					id, got.ID, group[0], want.ID)
			}
		}
	}
}

// Every model observed in a real database must be priceable, or a total is not
// a total. These ids are taken from the owner's machine.
func TestModelsSeenInTheWildArePriced(t *testing.T) {
	tab, err := Load("../../pricing/pricing.json")
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{
		"claude-opus-5", "claude-opus-4-8", "claude-sonnet-5", "claude-fable-5",
		"claude-haiku-4-5-20251001", "claude-opus-5[1m]",
		"deepseek-v4-pro", "minimax/minimax-m3", "minimax-m3", "MiniMax-M3", "MiniMax-M2.7",
	} {
		if _, ok := tab.Lookup(id); !ok {
			t.Errorf("%q is used on a real machine and has no price", id)
		}
	}
}

// A price change is not retroactive, and this is the test that says so.
//
// Sonnet 5 launched at an introductory $2/$10 and reverts to $3/$15 on
// 2026-08-31. Before dated rows existed, the only way to record that was to
// overwrite the figure — which would have restated every August turn at a
// price nobody was charged, growing a month's reported spend by half overnight.
func TestPriceUsesTheRowInForceWhenTheTurnRan(t *testing.T) {
	tbl, err := Embedded()
	if err != nil {
		t.Fatalf("embedded table: %v", err)
	}

	// One million input tokens, so the USD figure is the per-MTok price itself.
	d := event.TokenDelta{In: 1_000_000}

	for _, tc := range []struct {
		name string
		at   time.Time
		want float64
	}{
		{"during the introductory price", time.Date(2026, 8, 15, 12, 0, 0, 0, time.UTC), 2.0},
		{"the last day it applied", time.Date(2026, 8, 30, 23, 59, 59, 0, time.UTC), 2.0},
		{"the day it lapsed", time.Date(2026, 8, 31, 0, 0, 0, 0, time.UTC), 3.0},
		{"well after", time.Date(2026, 12, 1, 0, 0, 0, 0, time.UTC), 3.0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := tbl.PriceAt("claude-sonnet-5", d, tc.at)
			if !ok {
				t.Fatal("claude-sonnet-5 not priced")
			}
			if got != tc.want {
				t.Errorf("1M input tokens at %s: got $%.2f, want $%.2f", tc.at.Format("2006-01-02"), got, tc.want)
			}
		})
	}

	// No timestamp means "now", which must never resolve to a lapsed price.
	got, ok := tbl.Price("claude-sonnet-5", d)
	if !ok {
		t.Fatal("claude-sonnet-5 not priced without a timestamp")
	}
	if got != 3.0 {
		t.Errorf("undated lookup got $%.2f, want the current $3.00", got)
	}
}

// Every other model has exactly one row, and a typo that gave one an `until`
// would silently make it unpriceable at today's date. This is cheap insurance
// on a file that is edited by hand.
func TestEveryModelHasExactlyOneCurrentPrice(t *testing.T) {
	tbl, err := Embedded()
	if err != nil {
		t.Fatalf("embedded table: %v", err)
	}
	current := map[string]int{}
	for _, m := range tbl.Models {
		if m.Until == "" {
			current[m.ID]++
			continue
		}
		if _, err := time.Parse("2006-01-02", m.Until); err != nil {
			t.Errorf("%s: until %q is not YYYY-MM-DD", m.ID, m.Until)
		}
	}
	for _, m := range tbl.Models {
		if n := current[m.ID]; n != 1 {
			t.Errorf("%s has %d current rows (exactly one row must have no `until`)", m.ID, n)
		}
	}
}
