package rollup

import (
	"context"
	"math"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/cost"
	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/store"
)

// A turn whose model was missing from the table is priced once the table has
// it, and the session and daily totals move with it — no screen may disagree
// with the events. A turn already priced is never touched.
func TestPriceUnpricedFillsOnlyWhatWasNeverPriced(t *testing.T) {
	r, _ := newRecorder(t)
	ctx := context.Background()
	at := time.Date(2026, 9, 20, 10, 0, 0, 0, time.UTC)
	rec := func(key, model string) {
		ev := event.Event{Ts: at, SessionID: "s", Source: event.SourceCodex, Kind: event.KindTurnAssistant, Model: model, Key: key,
			Tokens: &event.TokenDelta{In: 1_000_000, Out: 1_000_000}}
		if _, err := r.Record(ctx, &ev, SessionInfo{Cwd: "/r", Agent: "codex"}); err != nil {
			t.Fatal(err)
		}
	}
	rec("a", "future-model-x")    // not in the table: stored with no cost
	rec("b", "claude-sonnet-4-5") // priced on arrival
	before, _ := store.GetStats(ctx, r.Store.DB(), "s")

	tb, err := cost.Parse([]byte(`{"version":"t","models":[{"id":"future-model-x","input":2,"cache_read":0.2,"output":10,"context_window":1000}]}`))
	if err != nil {
		t.Fatal(err)
	}
	r.Table = tb
	n, err := r.PriceUnpriced(ctx)
	if err != nil || n != 1 {
		t.Fatalf("priced %d, err %v", n, err)
	}
	after, _ := store.GetStats(ctx, r.Store.DB(), "s")
	if d := after.CostUSD - before.CostUSD; math.Abs(d-12) > 1e-9 {
		t.Fatalf("session total moved by %v, want 12", d)
	}
	var daily float64
	if err := r.Store.DB().QueryRow(`SELECT cost_usd FROM daily_stats WHERE model = 'future-model-x'`).Scan(&daily); err != nil || math.Abs(daily-12) > 1e-9 {
		t.Fatalf("daily = %v, err %v", daily, err)
	}
	// Idempotent: a second pass finds nothing.
	if n, _ := r.PriceUnpriced(ctx); n != 0 {
		t.Fatalf("second pass priced %d", n)
	}
}

// A correction reprices only the turns it names, from its date, moves the
// session and daily totals by the difference, and runs once per version.
func TestApplyCorrectionsRepricesOnlyNamedTurns(t *testing.T) {
	r, _ := newRecorder(t)
	ctx := context.Background()
	wrong, err := cost.Parse([]byte(`{"version":"v1","models":[{"id":"m","input":3,"output":15},{"id":"other","input":1,"output":1}]}`))
	if err != nil {
		t.Fatal(err)
	}
	r.Table = wrong
	rec := func(key, model string, at time.Time) {
		ev := event.Event{Ts: at, SessionID: "s", Source: event.SourceHook, Kind: event.KindTurnAssistant, Model: model, Key: key,
			Tokens: &event.TokenDelta{In: 1_000_000, Out: 1_000_000}}
		if _, err := r.Record(ctx, &ev, SessionInfo{Cwd: "/r", Agent: "claude"}); err != nil {
			t.Fatal(err)
		}
	}
	before := time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC)
	after := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	rec("a", "m", before) // before the correction's date: kept at 18
	rec("b", "m", after)  // corrected 18 -> 12
	rec("c", "other", after)

	right, err := cost.Parse([]byte(`{"version":"v2","models":[{"id":"m","input":2,"output":10},{"id":"other","input":5,"output":5}],
		"corrections":[{"model":"m","from":"2026-08-31"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	r.Table = right
	n, err := r.ApplyCorrections(ctx)
	if err != nil || n != 1 {
		t.Fatalf("corrected %d, err %v", n, err)
	}
	st, _ := store.GetStats(ctx, r.Store.DB(), "s")
	if want := 18.0 + 12 + 2; math.Abs(st.CostUSD-want) > 1e-9 {
		t.Fatalf("session total %v, want %v", st.CostUSD, want)
	}
	var sum float64
	if err := r.Store.DB().QueryRow(`SELECT SUM(cost_usd) FROM daily_stats WHERE model = 'm'`).Scan(&sum); err != nil || math.Abs(sum-30) > 1e-9 {
		t.Fatalf("daily m = %v, err %v", sum, err)
	}
	if n, _ := r.ApplyCorrections(ctx); n != 0 {
		t.Fatalf("second pass corrected %d", n)
	}
}

// The passes that price stored turns after the fact never touch a turn whose
// agent prices its own: OpenCode's figure stays OpenCode's, and a Cursor turn
// Cursor recorded no cost for stays unpriced (ADR-095) — even once the table
// has a row for its model, and even when a correction names that model.
func TestLatePricingSkipsAgentsThatPriceThemselves(t *testing.T) {
	r, _ := newRecorder(t)
	ctx := context.Background()
	at := time.Date(2026, 9, 20, 10, 0, 0, 0, time.UTC)
	own := 0.42
	rec := func(sess, key string, src event.Source, agent, model string, usd *float64) {
		ev := event.Event{Ts: at, SessionID: sess, Source: src, Kind: event.KindTurnAssistant, Model: model, Key: key,
			Tokens: &event.TokenDelta{In: 1_000_000, Out: 1_000_000}, CostUSD: usd}
		if _, err := r.Record(ctx, &ev, SessionInfo{Cwd: "/r", Agent: agent}); err != nil {
			t.Fatal(err)
		}
	}
	rec("oc", "a", event.SourceOpenCode, "opencode", "deepseek-v4-pro", &own)
	rec("cu", "b", event.SourceCursor, "cursor", "gpt-5", nil)
	rec("cx", "c", event.SourceCodex, "codex", "future-model-x", nil)

	tb, err := cost.Parse([]byte(`{"version":"t","models":[{"id":"deepseek-v4-pro","input":1,"output":1},{"id":"gpt-5","input":2,"output":2},{"id":"future-model-x","input":2,"output":2}],
		"corrections":[{"model":"deepseek-v4-pro"},{"model":"gpt-5"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	r.Table = tb
	if n, err := r.PriceUnpriced(ctx); err != nil || n != 1 {
		t.Fatalf("priced %d, err %v; want only the Codex turn", n, err)
	}
	if n, err := r.ApplyCorrections(ctx); err != nil || n != 0 {
		t.Fatalf("corrected %d, err %v; want none", n, err)
	}
	db := r.Store.DB()
	var oc float64
	if err := db.QueryRow(`SELECT cost_usd FROM events WHERE key = 'a'`).Scan(&oc); err != nil || oc != own {
		t.Errorf("OpenCode's own figure became %v (err %v)", oc, err)
	}
	var cu *float64
	if err := db.QueryRow(`SELECT cost_usd FROM events WHERE key = 'b'`).Scan(&cu); err != nil || cu != nil {
		t.Errorf("a Cursor turn with no recorded cost was priced: %v (err %v)", cu, err)
	}
}
