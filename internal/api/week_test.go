package api

import (
	"context"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/store"
)

func TestWeekDefaultsToTheSevenDaysEndingToday(t *testing.T) {
	e := newEnv(t)
	cost := 4.0
	ev := event.Event{SessionID: "w1", Source: event.SourceTranscript, Kind: event.KindTurnAssistant,
		Ts: e.now, Key: "t1", Model: "claude-opus-5", CostUSD: &cost, Tokens: &event.TokenDelta{In: 1, Out: 1, CacheRead: 1_000_000}}
	if _, err := store.InsertEvent(context.Background(), e.st.DB(), &ev); err != nil {
		t.Fatal(err)
	}
	var w WeekResponse
	if code := e.get(t, "/v1/week", &w); code != 200 {
		t.Fatalf("status %d", code)
	}
	// The env's clock is 2026-08-18 UTC; the window ends on that day.
	if w.Start != "2026-08-12" || w.End != "2026-08-18" || !w.Partial {
		t.Fatalf("window %s..%s partial=%v", w.Start, w.End, w.Partial)
	}
	if w.CostUSD != 4 || w.Turns != 1 {
		t.Fatalf("cost %v turns %d", w.CostUSD, w.Turns)
	}
	if w.Tax == nil || w.Tax.TaxUSD <= 0 {
		t.Fatalf("tax %+v", w.Tax)
	}
	// Nothing merged: no cost per PR, and it is not listed as an estimate.
	if w.CostPerMergedPR != nil {
		t.Fatalf("cost per PR %v with nothing merged", *w.CostPerMergedPR)
	}
	for _, f := range w.Estimates {
		if f == "cost_per_merged_pr" {
			t.Fatal("cost_per_merged_pr listed with nothing merged")
		}
	}
}

func TestWeekStartIsALocalDate(t *testing.T) {
	e := newEnv(t)
	var w WeekResponse
	if code := e.get(t, "/v1/week?start=2026-07-01", &w); code != 200 {
		t.Fatalf("status %d", code)
	}
	if w.Start != "2026-07-01" || w.End != "2026-07-07" || w.Partial {
		t.Fatalf("window %s..%s partial=%v", w.Start, w.End, w.Partial)
	}
	if got := time.UnixMilli(w.ToMs).Sub(time.UnixMilli(w.FromMs)); got != 7*24*time.Hour {
		t.Fatalf("window is %v long", got)
	}
	if code := e.get(t, "/v1/week?start=yesterday", nil); code != 400 {
		t.Fatalf("bad start answered %d, want 400", code)
	}
}
