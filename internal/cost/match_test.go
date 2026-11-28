package cost

import (
	"math"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
)

// A row's id is not a bare prefix. claude-fable-5-2 was priced as
// claude-fable-5 — 1.25x its input, 5x its cache read — because the one string
// began with the other. An id is matched by the row's id plus a suffix that
// names the same model, or not at all.
func TestRowIDIsNotABarePrefix(t *testing.T) {
	tb := &Table{Version: "t", Models: []Model{
		{ID: "claude-fable-5", Input: 10},
		{ID: "claude-haiku-4-5", Input: 1},
		{ID: "claude-sonnet-4-5", Input: 3},
		{ID: "minimax-m3", Input: 0.3},
		{ID: "kimi-k3", Input: 3},
		{ID: "kimi-k2.7-code", Input: 0.95},
		{ID: "gpt-5", Input: 1.25},
		{ID: "o3", Input: 2},
		{ID: "deepseek-flash", Input: 0.15},
		{ID: "gemini-3.1-pro-preview", Input: 2},
	}}
	accept := map[string]string{
		"claude-fable-5":                               "claude-fable-5",
		"claude-haiku-4-5-20251001":                    "claude-haiku-4-5",
		"us.anthropic.claude-sonnet-4-5-20250929-v1:0": "claude-sonnet-4-5",
		"anthropic.claude-sonnet-4-5-v2":               "claude-sonnet-4-5",
		"claude-sonnet-4-5@20250929":                   "claude-sonnet-4-5",
		"claude-sonnet-4-5:0":                          "claude-sonnet-4-5",
		"minimax/minimax-m3":                           "minimax-m3",
		"MiniMax-M3":                                   "minimax-m3",
		"kimi-k3[1m]":                                  "kimi-k3",
		"deepseek-flash[1m]":                           "deepseek-flash",
		"openai/gpt-5":                                 "gpt-5",
		"gpt-5:extended":                               "gpt-5",
		"claude-fable-5-20261101[1m]":                  "claude-fable-5",
	}
	for id, want := range accept {
		row, ok := tb.Lookup(id)
		if !ok || row.ID != want {
			t.Errorf("Lookup(%q) = %q,%v; want %q", id, row.ID, ok, want)
		}
	}
	for _, id := range []string{
		"claude-fable-5-2", "claude-fable-5.2", "minimax-m3.1-flash", "kimi-k3.1-pro",
		"kimi-k2.7-code-highspeed", "gpt-5.5", "gpt-5-mini", "gpt-5-codex", "o3-pro", "o3-mini",
		"gemini-3.1-pro-preview-customtools", "MiniMax-M3-Preview", "claude-haiku-4-5-2025",
	} {
		if row, ok := tb.Lookup(id); ok {
			t.Errorf("Lookup(%q) matched %q; another model's price must not apply", id, row.ID)
		}
	}
}

// Every id seen on a real machine that the table priced before the guard is
// still priced by the same row — except claude-fable-5-2, which now has its
// own. Taken from the owner's database on 2026-11-17, one per agent.
func TestObservedIDsKeepTheirRows(t *testing.T) {
	tb, err := Embedded()
	if err != nil {
		t.Fatal(err)
	}
	for id, want := range map[string]string{
		"claude-fable-5":            "claude-fable-5",
		"claude-fable-5-1":          "claude-fable-5-1",
		"claude-fable-5-2":          "claude-fable-5-2",
		"claude-haiku-4-5-20251001": "claude-haiku-4-5",
		"claude-haiku-5-5":          "claude-haiku-5-5",
		"claude-opus-4-8":           "claude-opus-4-8",
		"claude-opus-5":             "claude-opus-5",
		"claude-opus-5-5":           "claude-opus-5-5",
		"claude-sonnet-5":           "claude-sonnet-5",
		"claude-sonnet-5-5":         "claude-sonnet-5-5",
		"gpt-5-codex":               "gpt-5-codex",
		"gpt-5.6-luna":              "gpt-5.6-luna",
		"gpt-5.6-sol":               "gpt-5.6-sol",
		"gpt-6-astra":               "gpt-6-astra",
		"gpt-6-luna":                "gpt-6-luna",
		"gpt-6-sol":                 "gpt-6-sol",
		"gpt-6.1-sol":               "gpt-6.1-sol",
		"gpt-6.2-astra":             "gpt-6.2-astra",
		"gpt-6.2-sol":               "gpt-6.2-sol",
		"deepseek-v4-pro":           "deepseek-v4-pro",
		"MiniMax-M2.7":              "minimax-m2.7",
		"MiniMax-M3":                "minimax-m3",
		"minimax/minimax-m3":        "minimax-m3",
		"openai/gpt-5.5":            "gpt-5.5",
		"kimi-k3[1m]":               "kimi-k3",
		"kimi-k2.7-code":            "kimi-k2.7-code",
		"deepseek-v4-flash":         "deepseek-v4-flash",
	} {
		row, ok := tb.Lookup(id)
		if !ok || row.ID != want {
			t.Errorf("Lookup(%q) = %q,%v; want %q", id, row.ID, ok, want)
		}
	}
	// Ids the table must not price: no published per-token rate (Codex's
	// review model) or a different model than any row (Cursor's spellings).
	for _, id := range []string{"codex-auto-review", "composer-1", "claude-4-sonnet", "default", "gpt-5-fast"} {
		if row, ok := tb.Lookup(id); ok {
			t.Errorf("Lookup(%q) matched %q", id, row.ID)
		}
	}
}

// withNow sets the clock a lookup without a timestamp reads.
func withNow(t *testing.T, at time.Time) {
	t.Helper()
	old := now
	now = func() time.Time { return at }
	t.Cleanup(func() { now = old })
}

// A lookup with no timestamp means today, not "the row with no until". A price
// change entered in advance — Gemini 4 Carbon doubles on 2026-12-01 — must not
// show the December price in November.
func TestNoTimestampMeansNow(t *testing.T) {
	tb := &Table{Version: "t", Models: []Model{
		{ID: "gemini-4-carbon", Input: 2, Until: "2026-11-30"},
		{ID: "gemini-4-carbon", Input: 4},
	}}
	withNow(t, time.Date(2026, 11, 17, 12, 0, 0, 0, time.UTC))
	if row, _ := tb.Lookup("gemini-4-carbon"); row.Input != 2 {
		t.Errorf("on 2026-11-17 the price is $2, got $%v", row.Input)
	}
	if usd, _ := tb.Price("gemini-4-carbon", event.TokenDelta{In: 1_000_000}); math.Abs(usd-2) > 1e-9 {
		t.Errorf("Price with no timestamp on 2026-11-17: $%v, want $2", usd)
	}
	withNow(t, time.Date(2026, 11, 30, 23, 59, 0, 0, time.UTC))
	if row, _ := tb.Lookup("gemini-4-carbon"); row.Input != 2 {
		t.Errorf("the last day of the old price reads $%v", row.Input)
	}
	withNow(t, time.Date(2026, 12, 1, 0, 0, 0, 0, time.UTC))
	if row, _ := tb.Lookup("gemini-4-carbon"); row.Input != 4 {
		t.Errorf("from 2026-12-01 the price is $4, got $%v", row.Input)
	}
}

// The real table's entered-in-advance changes read right on both sides.
func TestDatedChangesInTheTable(t *testing.T) {
	tb, err := Embedded()
	if err != nil {
		t.Fatal(err)
	}
	day := func(y int, m time.Month, d int) time.Time { return time.Date(y, m, d, 12, 0, 0, 0, time.UTC) }
	for _, tc := range []struct {
		model  string
		at     time.Time
		input  float64
		output float64
	}{
		{"gemini-4-carbon", day(2026, 11, 17), 2, 10},
		{"gemini-4-carbon", day(2026, 12, 1), 4, 20},
		{"gemini-4-argon", day(2026, 11, 30), 2, 10},
		{"gemini-4-argon", day(2026, 12, 2), 4, 20},
		{"gemini-3.8-flash", day(2026, 12, 31), 0.75, 3.75},
		{"gemini-3.8-flash", day(2027, 1, 1), 1.5, 7.5},
		{"gemini-3.6-flash", day(2027, 1, 1), 1.5, 7.5},
		{"gemini-2.5-pro", day(2026, 11, 30), 1.25, 10},
		{"gemini-2.5-pro", day(2026, 12, 1), 0.75, 3.75}, // routed to 3.8 Flash
		{"gemini-2.5-pro", day(2027, 1, 1), 1.5, 7.5},
	} {
		row, ok := tb.LookupAt(tc.model, tc.at)
		if !ok || row.Input != tc.input || row.Output != tc.output {
			t.Errorf("%s on %s: $%v/$%v (ok %v), want $%v/$%v", tc.model, tc.at.Format("2006-01-02"), row.Input, row.Output, ok, tc.input, tc.output)
		}
	}
}

// A model priced by prompt length bills the whole request at the tier its
// prompt falls in, and the prompt counts cache reads and writes.
func TestTiersByPromptSize(t *testing.T) {
	tb := &Table{Version: "t", Models: []Model{{
		ID: "claude-haiku-5-5", Input: 0.10, CacheWrite5m: 0.125, CacheWrite1h: 0.20, CacheRead: 0.01, Output: 0.50,
		Tiers: []Tier{{AbovePromptTokens: 100_000, Input: 0.50, CacheWrite5m: 0.625, CacheWrite1h: 1.0, CacheRead: 0.05, Output: 2.50}},
	}}}
	small := event.TokenDelta{In: 10_000, CacheRead: 90_000, Out: 1_000} // exactly 100,000: the lower tier
	usd, _ := tb.Price("claude-haiku-5-5", small)
	want := (10_000*0.10 + 90_000*0.01 + 1_000*0.50) / mtok
	if math.Abs(usd-want) > 1e-12 {
		t.Errorf("100,000-token prompt: $%v, want $%v", usd, want)
	}
	// One cache-written token more crosses the threshold: everything is 5x.
	big := event.TokenDelta{In: 10_000, CacheRead: 90_000, CacheWrite: 1, CacheWrite1h: 1, Out: 1_000}
	usd, _ = tb.Price("claude-haiku-5-5", big)
	want = (10_000*0.50 + 90_000*0.05 + 1*1.0 + 1_000*2.50) / mtok
	if math.Abs(usd-want) > 1e-12 {
		t.Errorf("100,001-token prompt: $%v, want $%v", usd, want)
	}
	if got := PromptTokens(big); got != 100_001 {
		t.Errorf("PromptTokens = %d", got)
	}
}

// The tiers in the real table price the cases the audit of 2026-11-17 found.
func TestTiersInTheTable(t *testing.T) {
	tb, err := Embedded()
	if err != nil {
		t.Fatal(err)
	}
	at := time.Date(2026, 11, 17, 12, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		model string
		d     event.TokenDelta
		want  float64
	}{
		// Haiku 5.5 over 100,000 tokens: $0.50 input, $0.05 cache read, $2.50 output.
		{"claude-haiku-5-5", event.TokenDelta{In: 1_000, CacheRead: 200_000, Out: 1_000}, (1_000*0.50 + 200_000*0.05 + 1_000*2.50) / mtok},
		// gpt-6.1-sol over 272K: $4 input, $0.20 cached, $15 output.
		{"gpt-6.1-sol", event.TokenDelta{In: 10_000, CacheRead: 300_000, Out: 2_000}, (10_000*4 + 300_000*0.20 + 2_000*15) / mtok},
		// ... and at 272,000 exactly, the short-context rate.
		{"gpt-6.1-sol", event.TokenDelta{In: 2_000, CacheRead: 270_000, Out: 2_000}, (2_000*2 + 270_000*0.10 + 2_000*10) / mtok},
		// gpt-6.2-astra over 272K: $16 input, $0.80 cached, $60 output (2026-11-17.4).
		{"gpt-6.2-astra", event.TokenDelta{In: 10_000, CacheRead: 300_000, Out: 2_000}, (10_000*16 + 300_000*0.80 + 2_000*60) / mtok},
		// gpt-6.2-sol under it: $2 input, $0.10 cached, $10 output.
		{"gpt-6.2-sol", event.TokenDelta{In: 2_000, CacheRead: 100_000, Out: 2_000}, (2_000*2 + 100_000*0.10 + 2_000*10) / mtok},
		{"gemini-3.1-pro-preview", event.TokenDelta{In: 250_000, Out: 1_000}, (250_000*4 + 1_000*18) / mtok},
		{"minimax-m3", event.TokenDelta{In: 600_000, Out: 1_000}, (600_000*0.6 + 1_000*2.4) / mtok},
		// Fable 5.2 at its own price, not Fable 5's: the turn the audit found.
		{"claude-fable-5-2", event.TokenDelta{In: 2, CacheRead: 26_733, CacheWrite: 91_344, CacheWrite1h: 91_344, Out: 1_834},
			(2*8 + 26_733*0.20 + 91_344*16 + 1_834*40) / mtok},
		// DeepSeek V4 Pro at the page's off-peak price.
		{"deepseek-v4-pro", event.TokenDelta{In: 1_000_000, CacheRead: 1_000_000, Out: 1_000_000}, 0.66 + 0.022 + 1.98},
		{"kimi-k3[1m]", event.TokenDelta{In: 1_000, CacheWrite: 1_000, CacheRead: 1_000, Out: 1_000}, (1_000*3 + 1_000*3 + 1_000*0.30 + 1_000*15) / mtok},
		// Gemini 4 Neon (2026-11-28.1): $3 input, $0.15 cache read, $15 output at every prompt size.
		{"gemini-4-neon", event.TokenDelta{In: 300_000, CacheRead: 100_000, Out: 2_000}, (300_000*3 + 100_000*0.15 + 2_000*15) / mtok},
	} {
		got, ok := tb.PriceAt(tc.model, tc.d, at)
		if !ok || math.Abs(got-tc.want) > 1e-9 {
			t.Errorf("%s %+v: $%.6f (ok %v), want $%.6f", tc.model, tc.d, got, ok, tc.want)
		}
	}
}

// Tiers must rise and carry no negative price, or the table does not load.
func TestTiersAreValidated(t *testing.T) {
	for _, bad := range []string{
		`{"version":"x","models":[{"id":"m","input":1,"output":1,"tiers":[{"above_prompt_tokens":0,"input":2,"output":2}]}]}`,
		`{"version":"x","models":[{"id":"m","input":1,"output":1,"tiers":[{"above_prompt_tokens":200,"input":2,"output":2},{"above_prompt_tokens":100,"input":3,"output":3}]}]}`,
		`{"version":"x","models":[{"id":"m","input":1,"output":1,"tiers":[{"above_prompt_tokens":100,"input":-1,"output":2}]}]}`,
	} {
		if _, err := Parse([]byte(bad)); err == nil || !strings.Contains(err.Error(), "tier") {
			t.Errorf("accepted %s (%v)", bad, err)
		}
	}
}

// The compaction estimates choose the tier from the prompt they describe.
func TestCompactionEstimatesUseTheTier(t *testing.T) {
	tb := &Table{Version: "t", Models: []Model{{
		ID: "m", Input: 1, CacheRead: 0.1, Output: 5,
		Tiers: []Tier{{AbovePromptTokens: 100_000, Input: 2, CacheRead: 0.2, Output: 10}},
	}}}
	at := time.Date(2026, 11, 17, 0, 0, 0, 0, time.UTC)
	if usd, _ := tb.CompactionCost("m", at, 150_000, 1_000, true); math.Abs(usd-(150_000*0.2+1_000*10)/mtok) > 1e-12 {
		t.Errorf("compaction of a 150k context: $%v", usd)
	}
	if usd, _ := tb.CompactionCost("m", at, 50_000, 1_000, false); math.Abs(usd-(50_000*1+1_000*5)/mtok) > 1e-12 {
		t.Errorf("compaction of a 50k context: $%v", usd)
	}
	// A 30k call that dropped 80k would have sent 110k: the upper tier.
	if usd, _ := tb.CompactionSaving("m", at, 30_000, 80_000); math.Abs(usd-80_000*0.2/mtok) > 1e-12 {
		t.Errorf("saving: $%v", usd)
	}
	if usd, _ := tb.CompactionSaving("m", at, 10_000, 80_000); math.Abs(usd-80_000*0.1/mtok) > 1e-12 {
		t.Errorf("saving under the threshold: $%v", usd)
	}
}

// mtok keeps the expected figures floating-point: perMTok is an untyped
// integer constant, and an all-constant expression divided by it truncates.
const mtok = 1_000_000.0
