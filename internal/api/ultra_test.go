package api

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/dspv/caprock/internal/store"
)

func TestFiveHourEnded(t *testing.T) {
	now := int64(1_787_216_400_000)
	five := store.RateLimitSnapshot{Window: "five_hour", Ts: now - 6*3600_000, ResetsAt: now/1000 - 3600}
	cases := []struct {
		name string
		five store.RateLimitSnapshot
		week store.RateLimitSnapshot
		want bool
	}{
		{"ended, weekly reported since", five, store.RateLimitSnapshot{Ts: now - 60_000}, true},
		{"ended, nothing reported since", five, store.RateLimitSnapshot{Ts: five.Ts}, false},
		{"still running", store.RateLimitSnapshot{Ts: now - 3600_000, ResetsAt: now/1000 + 3600}, store.RateLimitSnapshot{Ts: now - 60_000}, false},
	}
	for _, c := range cases {
		if got := FiveHourEnded(c.five, c.week, now); got != c.want {
			t.Errorf("%s: FiveHourEnded = %v, want %v", c.name, got, c.want)
		}
	}
}

// A verified Ultra account has no five-hour limit, so its status line reports
// the weekly window alone. The five-hour reading left from before the move
// (Max 20×) is not served as a stale window forever: it is omitted.
func TestUltraAccountHasNoFiveHourWindow(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	now := e.now.UnixMilli()
	for _, s := range []store.RateLimitSnapshot{
		{Window: "five_hour", Ts: now - 6*3600_000, UsedPercentage: 40, ResetsAt: now/1000 - 3600},
		{Window: "seven_day", Ts: now - 60_000, UsedPercentage: 12, ResetsAt: now/1000 + 3*86400},
	} {
		if err := store.RecordRateLimit(ctx, e.st.DB(), s, "s1"); err != nil {
			t.Fatal(err)
		}
	}
	var lim struct {
		RateLimits map[string]json.RawMessage `json:"rate_limits"`
	}
	if code := e.get(t, "/v1/stats/limits", &lim); code != 200 {
		t.Fatalf("limits: %d", code)
	}
	if _, ok := lim.RateLimits["five_hour"]; ok {
		t.Errorf("an ended five-hour window is still served: %s", lim.RateLimits["five_hour"])
	}
	if _, ok := lim.RateLimits["seven_day"]; !ok {
		t.Errorf("the weekly window is missing: %v", lim.RateLimits)
	}
}
