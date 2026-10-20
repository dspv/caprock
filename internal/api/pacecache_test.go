package api

import (
	"context"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/store"
)

// The kept slope is the one RateLimitPace counts, and a new sample moves it.
func TestPaceIsKeptUntilANewSample(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open(ctx, ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	db := st.DB()
	now := time.Now()
	reset := now.Add(3 * time.Hour).Unix()
	rec := func(at time.Time, pct float64) {
		t.Helper()
		if err := store.RecordRateLimit(ctx, db, store.RateLimitSnapshot{Window: "five_hour", Ts: at.UnixMilli(), UsedPercentage: pct, ResetsAt: reset}, "s"); err != nil {
			t.Fatal(err)
		}
	}
	rec(now.Add(-2*time.Hour), 10)
	rec(now.Add(-time.Hour), 20)
	var c paceCache
	check := func(want float64) {
		t.Helper()
		got, ok, err := c.get(ctx, db, "five_hour", reset)
		direct, dok, derr := store.RateLimitPace(ctx, db, "five_hour", reset)
		if err != nil || derr != nil || ok != dok || got != direct {
			t.Fatalf("kept %v %v %v, counted %v %v %v", got, ok, err, direct, dok, derr)
		}
		if got < want-0.01 || got > want+0.01 {
			t.Fatalf("pace = %v %%/h, want %v", got, want)
		}
	}
	check(10)
	check(10)
	rec(now, 40) // 30 points in two hours
	check(15)
}
