package brain

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/config"
)

// lockedConfig lets a test flip the setting while the loop reads it.
type lockedConfig struct {
	mu  sync.Mutex
	cfg config.BrainConfig
}

func (l *lockedConfig) get() config.BrainConfig {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.cfg
}

func (l *lockedConfig) set(auto bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.cfg.Auto = &auto
}

func waitFor(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// Turning it on reads at once: the loop's own first wake is a minute away,
// so a read within seconds can only be the kick.
func TestTurningOnWakesAtOnceAndSaysWhenTheNextWakeIs(t *testing.T) {
	e := newEnv(t, nil)
	e.session(t, "s1", "acme-api", 20*time.Minute, [2]string{"Why is the cache test flaky?", long})
	cfg := &lockedConfig{cfg: config.BrainConfig{Since: e.cfg.Since}}
	e.eng.Config = cfg.get
	// The kicked read is held until the test has looked: with a runner that
	// returns at once, the loop may finish the read and schedule the next
	// wake (Interval on) before Status is asked, and "now" is gone.
	var calls atomic.Int32
	release := make(chan struct{})
	e.eng.Runner = RunnerFunc(func(ctx context.Context, _ Request) (Result, error) {
		calls.Add(1)
		select {
		case <-release:
		case <-ctx.Done():
			return Result{}, ctx.Err()
		}
		return twoMemories(Request{})
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	e.eng.Start(ctx)

	if st := e.eng.Status(ctx); st.NextWake != 0 {
		t.Fatalf("off: next_wake %d, want none", st.NextWake)
	}
	b, _ := json.Marshal(e.eng.Status(ctx))
	if strings.Contains(string(b), "next_wake") {
		t.Fatalf("off: %s carries next_wake", b)
	}

	cfg.set(true)
	e.eng.Kick()
	if st := e.eng.Status(ctx); st.NextWake != t0.UnixMilli() {
		t.Fatalf("just kicked: next_wake %d, want now %d", st.NextWake, t0.UnixMilli())
	}
	waitFor(t, "the kicked read", func() bool { return calls.Load() == 1 })
	// While the kicked read runs, the next wake is still the one asked for.
	if st := e.eng.Status(ctx); st.NextWake != t0.UnixMilli() {
		t.Fatalf("reading: next_wake %d, want now %d", st.NextWake, t0.UnixMilli())
	}
	close(release)
	want := t0.Add(Interval).UnixMilli()
	waitFor(t, "the next wake to be scheduled", func() bool {
		st := e.eng.Status(ctx)
		return !st.Running && st.NextWake == want
	})
	b, _ = json.Marshal(e.eng.Status(ctx))
	if !strings.Contains(string(b), `"next_wake":`) {
		t.Fatalf("on: %s has no next_wake", b)
	}

	cfg.set(false)
	if st := e.eng.Status(ctx); st.NextWake != 0 {
		t.Fatalf("turned off: next_wake %d, want none", st.NextWake)
	}
}

// A double click kicks twice; kicks while a read runs, and a wake asked for
// directly, never start a second run beside it, so no session is read twice.
func TestKicksDuringAReadNeverStartASecondRun(t *testing.T) {
	e := newEnv(t, nil)
	e.session(t, "s1", "acme-api", 20*time.Minute, [2]string{"Why is the cache test flaky?", long})
	e.session(t, "s2", "acme-api", 30*time.Minute, [2]string{"What about the cache store?", long})
	started := make(chan struct{}, 4)
	release := make(chan struct{})
	var calls, inFlight, most atomic.Int32
	var mu sync.Mutex
	per := map[string]int{}
	e.eng.Runner = RunnerFunc(func(_ context.Context, r Request) (Result, error) {
		calls.Add(1)
		n := inFlight.Add(1)
		defer inFlight.Add(-1)
		for {
			m := most.Load()
			if n <= m || most.CompareAndSwap(m, n) {
				break
			}
		}
		mu.Lock()
		for _, s := range []string{"Why is the cache test flaky?", "What about the cache store?"} {
			if strings.Contains(r.Prompt, s) {
				per[s]++
			}
		}
		mu.Unlock()
		started <- struct{}{}
		<-release
		return twoMemories(r)
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	e.eng.Start(ctx)

	e.eng.Kick()
	e.eng.Kick()
	<-started
	e.eng.Kick()
	if n, err := e.eng.Wake(ctx); n != 0 || err != nil {
		t.Fatalf("a wake beside a running one read %d (err %v)", n, err)
	}
	if !e.eng.Status(ctx).Running {
		t.Fatal("status does not say it is running")
	}
	close(release)
	waitFor(t, "both sessions", func() bool { return calls.Load() == 2 })
	// The kick that arrived during the read makes one more wake, which finds
	// nothing left to read.
	waitFor(t, "the queued wake", func() bool {
		st := e.eng.Status(ctx)
		return !st.Running && st.NextWake == t0.Add(Interval).UnixMilli()
	})
	time.Sleep(50 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if calls.Load() != 2 || most.Load() != 1 || len(per) != 2 {
		t.Fatalf("calls %d, at most %d at once, per session %v", calls.Load(), most.Load(), per)
	}
	for s, n := range per {
		if n != 1 {
			t.Errorf("%q read %d times", s, n)
		}
	}
}
