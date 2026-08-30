package api

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// The cache exists to collapse a burst, so what is tested is how many times the
// expensive function actually runs — not that a map returns what was put in it.

func TestHistoryCacheCollapsesConcurrentCallers(t *testing.T) {
	// Five components on the main screen ask for the same range at once. That
	// used to be five full scans of a 600 MB database for one answer.
	c := newHistoryCache(time.Minute, time.Now)
	var calls atomic.Int64
	release := make(chan struct{})

	var wg sync.WaitGroup
	got := make([]any, 5)
	for i := range got {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			v, err := c.get(context.Background(), "all", func() (any, error) {
				calls.Add(1)
				<-release // hold it open so every caller is demonstrably concurrent
				return "answer", nil
			})
			if err != nil {
				t.Errorf("caller %d: %v", i, err)
			}
			got[i] = v
		}(i)
	}
	// Let all five arrive before any can finish.
	time.Sleep(20 * time.Millisecond)
	close(release)
	wg.Wait()

	if n := calls.Load(); n != 1 {
		t.Errorf("computed %d times, want 1 — the burst was not collapsed", n)
	}
	for i, v := range got {
		if v != "answer" {
			t.Errorf("caller %d got %v, want every caller to share the one result", i, v)
		}
	}
}

func TestHistoryCacheRecomputesAfterTTL(t *testing.T) {
	// A cache that never expires is a screen that stops updating. Time is
	// injected rather than slept through: a test that waits for a real clock is
	// a test that is flaky on a loaded machine.
	now := time.Unix(0, 0)
	c := newHistoryCache(3*time.Second, func() time.Time { return now })
	var calls atomic.Int64
	fn := func() (any, error) { calls.Add(1); return calls.Load(), nil }

	if _, err := c.get(context.Background(), "all", fn); err != nil {
		t.Fatal(err)
	}
	now = now.Add(2 * time.Second) // still inside the window
	if _, err := c.get(context.Background(), "all", fn); err != nil {
		t.Fatal(err)
	}
	if n := calls.Load(); n != 1 {
		t.Errorf("recomputed inside the TTL (%d calls)", n)
	}

	now = now.Add(2 * time.Second) // now past it
	v, err := c.get(context.Background(), "all", fn)
	if err != nil {
		t.Fatal(err)
	}
	if n := calls.Load(); n != 2 {
		t.Errorf("did not recompute after the TTL (%d calls)", n)
	}
	if v != int64(2) {
		t.Errorf("served the stale value %v after expiry", v)
	}
}

func TestHistoryCacheKeepsRangesApart(t *testing.T) {
	// One key per range: serving today's figures under "all" would be a wrong
	// number, which is worse than a slow one.
	c := newHistoryCache(time.Minute, time.Now)
	all, err := c.get(context.Background(), "all", func() (any, error) { return "all", nil })
	if err != nil {
		t.Fatal(err)
	}
	today, err := c.get(context.Background(), "today", func() (any, error) { return "today", nil })
	if err != nil {
		t.Fatal(err)
	}
	if all != "all" || today != "today" {
		t.Errorf("ranges bled into each other: all=%v today=%v", all, today)
	}
}

func TestHistoryCacheDoesNotCacheFailures(t *testing.T) {
	// A transient failure — a busy database, a cancelled read — must not be
	// held for the TTL. Caching one turns a bad moment into seconds of a
	// broken screen.
	c := newHistoryCache(time.Minute, time.Now)
	boom := errors.New("busy")
	if _, err := c.get(context.Background(), "all", func() (any, error) { return nil, boom }); !errors.Is(err, boom) {
		t.Fatalf("got %v, want the error through", err)
	}
	v, err := c.get(context.Background(), "all", func() (any, error) { return "recovered", nil })
	if err != nil {
		t.Fatalf("second call still failing: %v", err)
	}
	if v != "recovered" {
		t.Errorf("got %v — the failure was cached", v)
	}
}

func TestHistoryCacheSurvivesACallerHangingUp(t *testing.T) {
	// Browsers abandon requests constantly, and this endpoint is polled by five
	// components at once. A caller that goes away must not take the answer away
	// from the callers still waiting for it.
	c := newHistoryCache(time.Minute, time.Now)
	release := make(chan struct{})
	started := make(chan struct{})
	var once sync.Once

	// First caller starts the work, then gives up.
	gone, cancel := context.WithCancel(context.Background())
	go func() {
		_, _ = c.get(gone, "all", func() (any, error) {
			once.Do(func() { close(started) })
			<-release
			return "answer", nil
		})
	}()
	<-started

	// Second caller arrives while the first is still in flight.
	type res struct {
		v   any
		err error
	}
	out := make(chan res, 1)
	go func() {
		v, err := c.get(context.Background(), "all", func() (any, error) {
			t.Error("second caller recomputed instead of waiting")
			return nil, nil
		})
		out <- res{v, err}
	}()

	time.Sleep(20 * time.Millisecond)
	cancel() // the first caller hangs up
	close(release)

	select {
	case r := <-out:
		if r.err != nil {
			t.Fatalf("waiter got %v — a disconnect took the answer away", r.err)
		}
		if r.v != "answer" {
			t.Errorf("waiter got %v, want the shared answer", r.v)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("waiter never woke: the computation was cancelled with its first caller")
	}
}
