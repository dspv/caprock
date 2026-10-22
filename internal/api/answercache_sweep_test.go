package api

import (
	"context"
	"testing"
	"time"
)

func cachedKeys(c *answerCache) map[string]bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := map[string]bool{}
	for k := range c.m {
		out[k] = true
	}
	return out
}

func TestAnswerCacheDropsKeysTooOldToShow(t *testing.T) {
	// Keys carry the start of their range, so yesterday's key is never asked
	// for again: without a sweep every cache kept a response per key and day
	// for as long as the daemon ran.
	now := time.Unix(0, 0)
	c := newAnswerCache(3*time.Second, 30*time.Second, func() time.Time { return now })
	fn := func() (any, error) { return 1, nil }
	get := func(k string) {
		t.Helper()
		if _, err := c.get(context.Background(), k, fn); err != nil {
			t.Fatal(err)
		}
	}
	get("day1")
	get("day2")
	// Inside maxStale nothing goes.
	now = now.Add(20 * time.Second)
	get("fresh")
	if k := cachedKeys(c); !k["day1"] || !k["day2"] || !k["fresh"] {
		t.Fatalf("dropped an answer still presentable: %v", k)
	}
	// Past it, the next key added sweeps them, once a sweepEvery.
	now = now.Add(sweepEvery)
	get("today")
	if k := cachedKeys(c); len(k) != 1 || !k["today"] {
		t.Errorf("after a sweep: %v, want only today", k)
	}
}

func TestAnswerCacheSweepKeepsWhatIsStillServed(t *testing.T) {
	now := time.Unix(0, 0)
	fn := func() (any, error) { return 1, nil }

	// An unchanged data version renews an answer for the recheck window.
	v := newAnswerCache(time.Second, 2*time.Second, func() time.Time { return now }).
		versioned(func(context.Context) (int64, error) { return 7, nil }, 5*time.Minute)
	if _, err := v.get(context.Background(), "old", fn); err != nil {
		t.Fatal(err)
	}
	now = now.Add(2 * sweepEvery)
	if _, err := v.get(context.Background(), "new", fn); err != nil {
		t.Fatal(err)
	}
	if !cachedKeys(v)["old"] {
		t.Error("swept an answer an unchanged version would still renew")
	}

	// No stale window at all: an answer lives for its TTL.
	now = time.Unix(0, 0)
	ttl := newAnswerCache(10*time.Minute, 0, func() time.Time { return now })
	if _, err := ttl.get(context.Background(), "a", fn); err != nil {
		t.Fatal(err)
	}
	now = now.Add(2 * sweepEvery)
	if _, err := ttl.get(context.Background(), "b", fn); err != nil {
		t.Fatal(err)
	}
	if !cachedKeys(ttl)["a"] {
		t.Error("swept an answer inside its TTL")
	}
}
