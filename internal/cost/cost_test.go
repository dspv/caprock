package cost

import (
	"math"
	"os"
	"path/filepath"
	"testing"

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
