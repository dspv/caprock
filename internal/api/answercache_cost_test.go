package api

import (
	"context"
	"sync/atomic"
	"testing"
	"time"
)

// A history answer is kept for costScale times what it took to compute
// (resource-usage audit F13): a cheap one (today) keeps the TTL, a costly one
// (all time on a large history) is refreshed less often, never past the
// ceiling, and a refreshed or renewed answer keeps the bound.
func TestAnswerCacheKeepsACostlyAnswerLonger(t *testing.T) {
	for _, tc := range []struct {
		name string
		cost time.Duration
		keep time.Duration // how long the answer is served without a refresh
	}{
		{"cheap keeps the TTL", 10 * time.Millisecond, 3 * time.Second},
		{"costly is kept 20x its cost", time.Second, 20 * time.Second},
		{"very costly stops at the ceiling", time.Minute, 2 * time.Minute},
	} {
		t.Run(tc.name, func(t *testing.T) {
			clk := &clock{t: time.Unix(0, 0)}
			c := newAnswerCache(3*time.Second, time.Hour, clk.now).costBound(20, 2*time.Minute)
			var calls atomic.Int64
			fn := func() (any, error) {
				clk.add(tc.cost) // the computation takes this long on the cache's clock
				return calls.Add(1), nil
			}
			if _, err := c.get(context.Background(), "all", fn); err != nil {
				t.Fatal(err)
			}
			clk.add(tc.keep - time.Millisecond)
			if v, _ := c.get(context.Background(), "all", fn); v != int64(1) || calls.Load() != 1 {
				t.Fatalf("refreshed before %v (calls %d)", tc.keep, calls.Load())
			}
			clk.add(2 * time.Millisecond)
			_, _ = c.get(context.Background(), "all", fn) // stale: starts one refresh
			c.wait()
			if n := calls.Load(); n != 2 {
				t.Fatalf("not refreshed after %v (calls %d)", tc.keep, n)
			}
			// The refreshed answer carries its own cost, so the bound holds
			// for it too.
			clk.add(tc.keep - time.Millisecond)
			if v, _ := c.get(context.Background(), "all", fn); v != int64(2) || calls.Load() != 2 {
				t.Fatalf("refreshed answer was not kept for %v (got %v, calls %d)", tc.keep, v, calls.Load())
			}
		})
	}
}

// Without costBound nothing changes: the TTL alone decides, however long the
// computation took.
func TestAnswerCacheIgnoresCostUnlessBound(t *testing.T) {
	clk := &clock{t: time.Unix(0, 0)}
	c := newAnswerCache(3*time.Second, time.Hour, clk.now)
	var calls atomic.Int64
	fn := func() (any, error) { clk.add(time.Minute); return calls.Add(1), nil }
	_, _ = c.get(context.Background(), "all", fn)
	clk.add(3 * time.Second)
	_, _ = c.get(context.Background(), "all", fn)
	c.wait()
	if n := calls.Load(); n != 2 {
		t.Fatalf("calls %d, want a refresh at the TTL", n)
	}
}
