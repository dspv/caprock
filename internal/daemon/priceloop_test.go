package daemon

import (
	"context"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/cost"
	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/loop"
	"github.com/dspv/caprock/internal/store"
)

// priceLoop is what turns a bare "stuck in a loop" alert into one that says
// what the repetition paid to re-read the conversation. The whole path is
// exercised here -- store query, msg_id linkage, per-model rates -- because
// its failure mode is silent: an alert with no tax simply says less.
func TestPriceLoopFillsTheTaxFromRealEvents(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open(ctx, ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	table, err := cost.Embedded()
	if err != nil {
		t.Fatal(err)
	}

	base := time.Now().Add(-time.Minute).Truncate(time.Millisecond)
	// One assistant turn carrying a large context, and five Bash calls issued
	// by it -- the shape the detector alerts on.
	turn := event.Event{
		SessionID: "loopy", Source: event.SourceHook, Kind: event.KindTurnAssistant,
		Ts: base, Key: "turn", MsgID: "m1", Model: "claude-opus-5",
		Tokens: &event.TokenDelta{In: 2_000, CacheRead: 400_000, CacheWrite: 1_000, Out: 300},
	}
	if _, err := store.InsertEvent(ctx, st.DB(), &turn); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 5; i++ {
		e := event.Event{
			SessionID: "loopy", Source: event.SourceHook, Kind: event.KindToolPre,
			Tool: "Bash", Ts: base.Add(time.Duration(i+1) * time.Second),
			Key: string(rune('a'+i)) + "call", MsgID: "m1",
		}
		if _, err := store.InsertEvent(ctx, st.DB(), &e); err != nil {
			t.Fatal(err)
		}
	}

	d := &Daemon{store: st, log: quietLog(), table: table}
	a := &loop.Alert{
		Kind: "loop", SessionID: "loopy", Tool: "Bash", Count: 5,
		FirstTs: base, LastTs: base.Add(time.Minute),
	}
	d.priceLoop(ctx, a)

	if a.TaxUSD <= 0 {
		t.Fatalf("tax not filled: %+v", a)
	}
	// Five calls re-reading 403k tokens at Opus 5's cache-read rate.
	row, _ := table.Lookup("claude-opus-5")
	want := 5 * 403_000 * row.CacheRead / 1_000_000
	if diff := a.TaxUSD - want; diff > 1e-9 || diff < -1e-9 {
		t.Fatalf("tax = %v, want %v", a.TaxUSD, want)
	}
	if a.TaxPricedCalls != 5 {
		t.Fatalf("priced calls = %d, want 5", a.TaxPricedCalls)
	}
	// Isolation is the informational counterfactual: the same calls in a
	// subagent never re-read the parent's 400k, so it must come out far below.
	if a.IsolatedUSD >= a.TaxUSD {
		t.Fatalf("isolated %v should be well below the tax %v", a.IsolatedUSD, a.TaxUSD)
	}
}

// An alert whose calls cannot be priced keeps its zero fields, so the UI omits
// the figure rather than printing a $0.00 that reads as "this was free".
func TestPriceLoopLeavesAnUnpriceableAlertAlone(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open(ctx, ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	table, _ := cost.Embedded()

	base := time.Now().Add(-time.Minute)
	// A hook-plane call: no msg_id, so nothing says which turn paid for it.
	e := event.Event{
		SessionID: "hookonly", Source: event.SourceHook, Kind: event.KindToolPre,
		Tool: "Bash", Ts: base, Key: "c1",
	}
	if _, err := store.InsertEvent(ctx, st.DB(), &e); err != nil {
		t.Fatal(err)
	}

	d := &Daemon{store: st, log: quietLog(), table: table}
	a := &loop.Alert{Kind: "loop", SessionID: "hookonly", Tool: "Bash", Count: 5,
		FirstTs: base.Add(-time.Minute), LastTs: base.Add(time.Minute)}
	d.priceLoop(ctx, a)

	if a.TaxUSD != 0 || a.TaxPricedCalls != 0 {
		t.Fatalf("an unpriceable alert must stay unpriced, got %+v", a)
	}
}

// Pricing must never panic a daemon that has no table or no store yet: an
// alert that cannot be priced is a smaller alert, not a crash.
func TestPriceLoopIsSafeBeforeTheDaemonIsReady(t *testing.T) {
	a := &loop.Alert{Kind: "loop", SessionID: "s", Count: 5}
	(&Daemon{log: quietLog()}).priceLoop(context.Background(), a)
	if a.TaxUSD != 0 {
		t.Fatalf("got %+v", a)
	}
}
