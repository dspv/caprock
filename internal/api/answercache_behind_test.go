package api

import (
	"context"
	"sync/atomic"
	"testing"
	"time"
)

// An answer built on parts the throttle held back is served, but an unchanged
// version never renews it: past its TTL it is counted again, and the answer
// that caught up is then kept on its version as usual.
func TestAnswerCacheDoesNotRenewABehindAnswer(t *testing.T) {
	now := time.Unix(0, 0)
	var ver atomic.Int64
	c := newAnswerCache(todayTTL, todayTTL, func() time.Time { return now }).
		versioned(func(context.Context) (int64, error) { return ver.Load(), nil }, time.Minute)
	var calls atomic.Int64
	var behind atomic.Bool
	behind.Store(true)
	get := func() any {
		t.Helper()
		v, err := c.get(context.Background(), "today", func() (any, error) {
			n := calls.Add(1)
			var lag atomic.Bool
			lag.Store(behind.Load())
			return lagged(n, &lag), nil
		})
		if err != nil {
			t.Fatal(err)
		}
		c.wait()
		return v
	}
	if v := get(); v != int64(1) {
		t.Fatalf("got %v, want the answer itself, unwrapped", v)
	}
	// Nothing written since, yet it was behind: counted again past the TTL.
	now = now.Add(todayTTL)
	if v := get(); v != int64(2) {
		t.Fatalf("a behind answer was renewed on its version: got %v", v)
	}
	// Caught up: from now on an unchanged version renews it.
	behind.Store(false)
	now = now.Add(todayTTL)
	get()
	for range 5 {
		now = now.Add(todayTTL)
		get()
	}
	if n := calls.Load(); n != 3 {
		t.Fatalf("computed %d times, want 3: the caught-up answer renewed on its version", n)
	}
}
