package daemon

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/api"
	"github.com/dspv/caprock/internal/brain"
	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/config"
)

// Turning building on wakes the reader at once, on the engine's own
// goroutine; saying yes again (a double click) or changing a limit while it
// is on does not wake it a second time.
func TestBrainTurnedOnWakesOnceAtOnce(t *testing.T) {
	d := &Daemon{log: quietLog(), store: memStore(t), bus: bus.New(), opt: Options{DataDir: t.TempDir()}}
	// Every reading of the clock is a millisecond later, so each wake leaves
	// its own last_wake.
	var tick atomic.Int64
	base := time.Date(2026, 10, 15, 9, 0, 0, 0, time.UTC)
	eng := &brain.Engine{
		Store: d.store, Bus: d.bus, Log: d.log,
		Now:    func() time.Time { return base.Add(time.Duration(tick.Add(1)) * time.Millisecond) },
		Config: func() config.BrainConfig { return d.config().Brain },
		Runner: brain.RunnerFunc(func(context.Context, brain.Request) (brain.Result, error) {
			t.Error("the real reader must not be called here")
			return brain.Result{}, nil
		}),
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	eng.Start(ctx)
	b := &brainAdapter{d: d, eng: eng}

	if st := eng.Status(ctx); st.LastWake != 0 || st.NextWake != 0 {
		t.Fatalf("before the yes: last_wake %d, next_wake %d", st.LastWake, st.NextWake)
	}
	yes := true
	// The request's context ends as soon as the handler returns; the wake
	// must not depend on it.
	reqCtx, reqDone := context.WithCancel(context.Background())
	if err := b.Configure(reqCtx, api.BrainSettings{Auto: &yes}); err != nil {
		t.Fatal(err)
	}
	reqDone()
	waitFor(t, "the first wake", func() bool { return eng.Status(ctx).LastWake != 0 })
	waitFor(t, "the wake to finish", func() bool { return !eng.Status(ctx).Running })
	first := eng.Status(ctx).LastWake
	if d.config().Brain.Since == 0 {
		t.Error("since was not set on the yes")
	}

	model := "sonnet"
	for _, set := range []api.BrainSettings{{Auto: &yes}, {Auto: &yes}, {Model: &model}} {
		if err := b.Configure(context.Background(), set); err != nil {
			t.Fatal(err)
		}
	}
	time.Sleep(150 * time.Millisecond)
	st := eng.Status(ctx)
	if st.LastWake != first {
		t.Fatalf("a repeated yes woke the reader again: last_wake %d, then %d", first, st.LastWake)
	}
	if st.NextWake == 0 {
		t.Error("on, but no next_wake")
	}
}
