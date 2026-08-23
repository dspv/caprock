package daemon

import (
	"context"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/rollup"
	"github.com/dspv/caprock/internal/store"
)

// seedEvents inserts n events spread across the past n days and returns the
// resulting count.
func seedEvents(t *testing.T, st *store.Store, n int) int64 {
	t.Helper()
	ctx := context.Background()
	if err := st.WithTx(ctx, func(q store.Querier) error {
		for i := range n {
			ev := &event.Event{
				Ts:        time.Now().AddDate(0, 0, -i),
				SessionID: "s-1",
				Source:    event.SourceHook,
				Kind:      event.KindTurnUser,
				Key:       string(rune('a' + i)),
			}
			if _, err := store.InsertEvent(ctx, q, ev); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	var got int64
	if err := st.WithTx(ctx, func(q store.Querier) error {
		var err error
		got, err = store.CountEvents(ctx, q)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if got != int64(n) {
		t.Fatalf("seeded %d events, store holds %d", n, got)
	}
	return got
}

func countEvents(t *testing.T, st *store.Store) int64 {
	t.Helper()
	var got int64
	if err := st.WithTx(context.Background(), func(q store.Querier) error {
		var err error
		got, err = store.CountEvents(context.Background(), q)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	return got
}

// TestPruneRefusesZeroRetention proves the prune pass deletes nothing when
// retention is 0 ("keep forever"). pruneLoop is gated on RetentionDays > 0 at
// startup, but its inner closure re-reads the config on every tick, so a
// retention that reached 0 at runtime would compute AddDate(0,0,0) — i.e. now —
// and delete the user's entire event history.
//
// Removing the `if days <= 0 { return }` guard in prune() makes this fail with
// "prune deleted the entire history: 10 events → 0".
func TestPruneRefusesZeroRetention(t *testing.T) {
	st := memStore(t)
	before := seedEvents(t, st, 10)

	d := &Daemon{
		log:   quietLog(),
		store: st,
		rec:   rollup.New(st, embeddedTable(t), bus.New(), quietLog()),
		// 0 = keep forever. The startup gate would not have started the loop, but
		// the closure must be safe on its own.
		opt: Options{Config: config.Config{RetentionDays: 0}, IdleAfter: time.Minute, EndAfter: time.Hour},
	}

	// Run one prune pass: pruneLoop prunes once immediately, then tickers.
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); d.pruneLoop(ctx) }()
	// Give the immediate pass time to run before cancelling.
	time.Sleep(50 * time.Millisecond)
	cancel()
	<-done

	if after := countEvents(t, st); after != before {
		t.Errorf("prune deleted the entire history: %d events → %d", before, after)
	}
}

// TestPruneWithNegativeRetentionKeepsEverything covers a config that is not just
// zero but nonsensical; AddDate with a positive offset would set the cutoff in
// the future and delete everything including today's events.
func TestPruneWithNegativeRetentionKeepsEverything(t *testing.T) {
	st := memStore(t)
	before := seedEvents(t, st, 5)

	d := &Daemon{
		log:   quietLog(),
		store: st,
		rec:   rollup.New(st, embeddedTable(t), bus.New(), quietLog()),
		opt:   Options{Config: config.Config{RetentionDays: -30}, IdleAfter: time.Minute, EndAfter: time.Hour},
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); d.pruneLoop(ctx) }()
	time.Sleep(50 * time.Millisecond)
	cancel()
	<-done

	if after := countEvents(t, st); after != before {
		t.Errorf("negative retention deleted events: %d → %d", before, after)
	}
}

// TestPruneStillPrunesWhenConfigured is the counterweight: the guard must not
// have disabled pruning altogether.
func TestPruneStillPrunesWhenConfigured(t *testing.T) {
	st := memStore(t)
	seedEvents(t, st, 10) // one per day, going back 9 days

	d := &Daemon{
		log:   quietLog(),
		store: st,
		rec:   rollup.New(st, embeddedTable(t), bus.New(), quietLog()),
		opt:   Options{Config: config.Config{RetentionDays: 5}, IdleAfter: time.Minute, EndAfter: time.Hour},
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); d.pruneLoop(ctx) }()
	time.Sleep(50 * time.Millisecond)
	cancel()
	<-done

	after := countEvents(t, st)
	if after == 10 {
		t.Error("nothing was pruned; the guard disabled retention entirely")
	}
	if after == 0 {
		t.Error("everything was pruned; only events older than 5 days should go")
	}
}
