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

func TestAnswerCacheCollapsesConcurrentCallers(t *testing.T) {
	// Five components on the main screen ask for the same range at once. That
	// used to be five full scans of a 600 MB database for one answer.
	c := newAnswerCache(time.Minute, 0, time.Now)
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

func TestAnswerCacheRecomputesAfterTTL(t *testing.T) {
	// A cache that never expires is a screen that stops updating. Time is
	// injected rather than slept through: a test that waits for a real clock is
	// a test that is flaky on a loaded machine.
	now := time.Unix(0, 0)
	c := newAnswerCache(3*time.Second, 0, func() time.Time { return now })
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

func TestAnswerCacheKeepsRangesApart(t *testing.T) {
	// One key per range: serving today's figures under "all" would be a wrong
	// number, which is worse than a slow one.
	c := newAnswerCache(time.Minute, 0, time.Now)
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

func TestAnswerCacheDoesNotCacheFailures(t *testing.T) {
	// A transient failure — a busy database, a cancelled read — must not be
	// held for the TTL. Caching one turns a bad moment into seconds of a
	// broken screen.
	c := newAnswerCache(time.Minute, 0, time.Now)
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

func TestAnswerCacheSurvivesACallerHangingUp(t *testing.T) {
	// Browsers abandon requests constantly, and this endpoint is polled by five
	// components at once. A caller that goes away must not take the answer away
	// from the callers still waiting for it.
	c := newAnswerCache(time.Minute, 0, time.Now)
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

// clock is a settable time source that is safe to read from the cache's
// background refresh while the test moves it.
type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *clock) add(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

func TestAnswerCacheServesStaleAndRefreshesOnce(t *testing.T) {
	// Past the TTL the old answer comes back at once — nobody waits on a
	// whole-table scan — and a burst of such hits starts ONE refresh, not one
	// each, or the burst the cache exists to collapse comes straight back.
	clk := &clock{t: time.Unix(0, 0)}
	c := newAnswerCache(3*time.Second, time.Minute, clk.now)
	var calls atomic.Int64
	release := make(chan struct{})
	fn := func() (any, error) {
		n := calls.Add(1)
		if n > 1 {
			<-release // hold the refresh open so the burst is demonstrably concurrent
		}
		return n, nil
	}
	if v, _ := c.get(context.Background(), "all", fn); v != int64(1) {
		t.Fatalf("first answer %v", v)
	}
	clk.add(10 * time.Second)
	for i := 0; i < 5; i++ {
		v, err := c.get(context.Background(), "all", fn)
		if err != nil {
			t.Fatal(err)
		}
		if v != int64(1) {
			t.Errorf("stale hit %d got %v, want the stale answer straight back", i, v)
		}
	}
	close(release)
	c.wait()
	if n := calls.Load(); n != 2 {
		t.Errorf("computed %d times, want 2 — one first answer and one refresh for the whole burst", n)
	}
	if v, _ := c.get(context.Background(), "all", fn); v != int64(2) {
		t.Errorf("after the refresh got %v, want the refreshed answer", v)
	}
}

func TestAnswerCacheRecomputesPastMaxStale(t *testing.T) {
	// An answer from hours ago is not shown as the current one: past maxStale
	// the caller waits for a fresh figure.
	clk := &clock{t: time.Unix(0, 0)}
	c := newAnswerCache(3*time.Second, time.Minute, clk.now)
	var calls atomic.Int64
	fn := func() (any, error) { return calls.Add(1), nil }
	_, _ = c.get(context.Background(), "all", fn)
	clk.add(2 * time.Hour)
	v, err := c.get(context.Background(), "all", fn)
	if err != nil {
		t.Fatal(err)
	}
	if v != int64(2) {
		t.Errorf("got %v two hours later, want a freshly computed answer", v)
	}
	c.wait()
}

func TestAnswerCacheKeepsTheStaleAnswerWhenARefreshFails(t *testing.T) {
	// A refresh that fails (a busy database) must not take away the figure
	// the screen already has, and must not stop the next stale hit retrying.
	clk := &clock{t: time.Unix(0, 0)}
	c := newAnswerCache(3*time.Second, time.Minute, clk.now)
	fail := atomic.Bool{}
	var calls atomic.Int64
	fn := func() (any, error) {
		n := calls.Add(1)
		if fail.Load() {
			return nil, errors.New("busy")
		}
		return n, nil
	}
	_, _ = c.get(context.Background(), "all", fn)
	clk.add(10 * time.Second)
	fail.Store(true)
	if v, err := c.get(context.Background(), "all", fn); err != nil || v != int64(1) {
		t.Fatalf("stale hit got %v, %v", v, err)
	}
	c.wait()
	fail.Store(false)
	if v, err := c.get(context.Background(), "all", fn); err != nil || v != int64(1) {
		t.Fatalf("after a failed refresh got %v, %v — want the stale answer kept", v, err)
	}
	c.wait()
	if v, _ := c.get(context.Background(), "all", fn); v != int64(3) {
		t.Errorf("got %v, want the answer of the retried refresh", v)
	}
}
