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

func TestWeekPeriodsAreWholeLocalDaysEndingToday(t *testing.T) {
	e := newEnv(t)
	cost := 2.0
	old := event.Event{SessionID: "w2", Source: event.SourceTranscript, Kind: event.KindTurnAssistant,
		Ts: e.now.AddDate(0, 0, -40), Key: "old", Model: "claude-opus-5", CostUSD: &cost, Tokens: &event.TokenDelta{In: 1, Out: 1}}
	now := event.Event{SessionID: "w2", Source: event.SourceTranscript, Kind: event.KindTurnAssistant,
		Ts: e.now, Key: "now", Model: "claude-opus-5", CostUSD: &cost, Tokens: &event.TokenDelta{In: 1, Out: 1}}
	for _, ev := range []*event.Event{&old, &now} {
		if _, err := store.InsertEvent(context.Background(), e.st.DB(), ev); err != nil {
			t.Fatal(err)
		}
	}
	cases := []struct {
		period, start string
		days          int
		cost          float64
	}{
		{"today", "2026-08-18", 1, 2},
		{"7d", "2026-08-12", 7, 2},
		{"30d", "2026-07-20", 30, 2},
		{"all", e.now.AddDate(0, 0, -40).Format("2006-01-02"), 41, 4},
	}
	for _, c := range cases {
		var w WeekResponse
		if code := e.get(t, "/v1/week?period="+c.period, &w); code != 200 {
			t.Fatalf("%s: status %d", c.period, code)
		}
		if w.Period != c.period || w.Start != c.start || w.End != "2026-08-18" || len(w.Days) != c.days || w.CostUSD != c.cost {
			t.Fatalf("%s: period=%q %s..%s days=%d cost=%v", c.period, w.Period, w.Start, w.End, len(w.Days), w.CostUSD)
		}
	}
	if code := e.get(t, "/v1/week?period=year", nil); code != 400 {
		t.Fatalf("unknown period answered %d, want 400", code)
	}
	if code := e.get(t, "/v1/week?period=7d&start=2026-08-01", nil); code != 400 {
		t.Fatalf("period and start together answered %d, want 400", code)
	}
}

// The all-time Week took 7-13 s on the owner's database when first asked for,
// so a start computes it (and the 30-day one) before anyone opens the dialog.
func TestWarmComputesTheLongWeeks(t *testing.T) {
	e := newEnv(t)
	e.api.Warm(context.Background())
	for _, period := range []string{"all", "30d"} {
		from, to, err := e.api.weekPeriod(context.Background(), period)
		if err != nil {
			t.Fatal(err)
		}
		key := "week:" + period + ":" + from.Format("2006-01-02") + ":" + to.Format("2006-01-02")
		e.api.weekLong.mu.Lock()
		_, ok := e.api.weekLong.m[key]
		e.api.weekLong.mu.Unlock()
		if !ok {
			t.Errorf("Warm left the %s Week to the first request", period)
		}
	}
}
