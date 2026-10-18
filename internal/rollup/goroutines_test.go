package rollup

import (
	"context"
	"runtime/metrics"
	"testing"
)

func goroutinesCreated(t *testing.T) uint64 {
	t.Helper()
	s := []metrics.Sample{{Name: "/sched/goroutines-created:goroutines"}}
	metrics.Read(s)
	if s[0].Value.Kind() != metrics.KindUint64 {
		t.Skip("this Go runtime does not count created goroutines")
	}
	return s[0].Value.Uint64()
}

// Recording starts no goroutines (F15 in the resource audit). A *sql.Tx
// started one per query to watch its context, and the SQLite driver one per
// statement on a cancellable context: four or five per event, which a first
// import paid for in thread wake-ups on every one of 181k events. The callers'
// contexts here are cancellable on purpose.
func TestRecordingStartsNoGoroutines(t *testing.T) {
	r, _, _ := fileRecorder(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// Warm the pool, so opening connections is not counted.
	if _, err := r.Record(ctx, batchTurn("warm", 0), SessionInfo{Cwd: "/p"}); err != nil {
		t.Fatal(err)
	}

	before := goroutinesCreated(t)
	b := r.Batch(ctx)
	for i := 0; i < 200; i++ {
		if _, err := b.Record(ctx, batchTurn("g", i), SessionInfo{Cwd: "/p"}); err != nil {
			t.Fatal(err)
		}
	}
	if _, _, err := b.Flush(); err != nil {
		t.Fatal(err)
	}
	for i := 200; i < 400; i++ {
		if _, err := r.Record(ctx, batchTurn("g", i), SessionInfo{Cwd: "/p"}); err != nil {
			t.Fatal(err)
		}
	}
	// A handful is allowed for the runtime's own work; per-event cost is not.
	if n := goroutinesCreated(t) - before; n > 20 {
		t.Fatalf("recording 400 events started %d goroutines", n)
	}
}
