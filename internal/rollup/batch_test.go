package rollup

import (
	"context"
	"database/sql"
	"fmt"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/cost"
	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/store"
)

// fileRecorder is a recorder on a database file, so other connections see
// only what is committed.
func fileRecorder(t *testing.T) (*Recorder, *bus.Subscriber, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "c.db")
	st, err := store.Open(context.Background(), path, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	tb, err := cost.Embedded()
	if err != nil {
		t.Fatal(err)
	}
	b := bus.New()
	sub := b.Subscribe(4096)
	r := New(st, tb, b, nil)
	r.Location = time.UTC
	return r, sub, path
}

func batchTurn(session string, i int) *event.Event {
	return &event.Event{
		Ts: time.Date(2026, 10, 18, 10, 0, i, 0, time.UTC), SessionID: session,
		Source: event.SourceTranscript, Kind: event.KindTurnAssistant,
		Key: fmt.Sprintf("msg:%s-%d", session, i), MsgID: fmt.Sprintf("%s-%d", session, i),
		Model: "claude-opus-4-1", Tokens: &event.TokenDelta{In: 10, Out: 5},
	}
}

func countRows(t *testing.T, db *sql.DB, session string) (events, turns int) {
	t.Helper()
	if err := db.QueryRow(`SELECT COUNT(*) FROM events JOIN sessions USING (sid) WHERE session_id = ?`, session).Scan(&events); err != nil {
		t.Fatal(err)
	}
	_ = db.QueryRow(`SELECT COALESCE(turns, 0) FROM session_stats WHERE session_id = ?`, session).Scan(&turns)
	return events, turns
}

// A batch is due at its event limit, holds nothing visible until it commits,
// and publishes only after the commit, one session frame per session.
func TestBatchCommitsAtItsBoundaries(t *testing.T) {
	r, sub, path := fileRecorder(t)
	other, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	ctx := context.Background()
	b := r.Batch(ctx)
	b.MaxEvents, b.MaxAge = 3, time.Hour
	for i := 0; i < 3; i++ {
		if b.Due() {
			t.Fatalf("due after %d events, limit 3", i)
		}
		if _, err := b.Record(ctx, batchTurn("s1", i), SessionInfo{Cwd: "/p"}); err != nil {
			t.Fatal(err)
		}
	}
	if !b.Due() {
		t.Fatal("not due at the event limit")
	}
	if n, _ := countRows(t, other, "s1"); n != 0 {
		t.Fatalf("%d events visible before the commit", n)
	}
	if fr := drain(sub); len(fr) != 0 {
		t.Fatalf("%d frames published before the commit", len(fr))
	}
	stored, deduped, err := b.Flush()
	if err != nil || stored != 3 || deduped != 0 {
		t.Fatalf("flush = %d stored, %d deduped, %v", stored, deduped, err)
	}
	if n, turns := countRows(t, other, "s1"); n != 3 || turns != 3 {
		t.Fatalf("after commit %d events, %d turns; want 3, 3", n, turns)
	}
	var events, sessions int
	for _, f := range drain(sub) {
		switch f.Type {
		case bus.FrameEvent:
			events++
		case bus.FrameSession:
			sessions++
		}
	}
	if events != 3 || sessions != 1 {
		t.Fatalf("published %d event and %d session frames, want 3 and 1", events, sessions)
	}

	// The age limit, on a batch that is reused after a flush.
	b.MaxEvents, b.MaxAge = 1000, 10*time.Millisecond
	if _, err := b.Record(ctx, batchTurn("s1", 3), SessionInfo{}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(20 * time.Millisecond)
	if !b.Due() {
		t.Fatal("not due after its age limit")
	}
	if _, _, err := b.Flush(); err != nil {
		t.Fatal(err)
	}
}

// A batch that never commits — rolled back, or lost with the process — leaves
// nothing behind, and recording the same events again stores each once and
// counts each once.
func TestAnAbortedBatchLosesNothingAndCountsNothingTwice(t *testing.T) {
	r, sub, _ := fileRecorder(t)
	ctx := context.Background()
	db := r.Store.DB()

	b := r.Batch(ctx)
	for i := 0; i < 5; i++ {
		if _, err := b.Record(ctx, batchTurn("s2", i), SessionInfo{Cwd: "/p"}); err != nil {
			t.Fatal(err)
		}
	}
	b.Abort()
	if n, turns := countRows(t, db, "s2"); n != 0 || turns != 0 {
		t.Fatalf("after abort %d events, %d turns", n, turns)
	}
	if fr := drain(sub); len(fr) != 0 {
		t.Fatalf("an aborted batch published %d frames", len(fr))
	}

	for pass := 0; pass < 2; pass++ {
		b := r.Batch(ctx)
		for i := 0; i < 5; i++ {
			if _, err := b.Record(ctx, batchTurn("s2", i), SessionInfo{Cwd: "/p"}); err != nil {
				t.Fatal(err)
			}
		}
		stored, deduped, err := b.Flush()
		if err != nil {
			t.Fatal(err)
		}
		if want := 5 * (1 - pass); stored != want || deduped != 5-want {
			t.Fatalf("pass %d: %d stored, %d deduped", pass, stored, deduped)
		}
		if n, turns := countRows(t, db, "s2"); n != 5 || turns != 5 {
			t.Fatalf("pass %d: %d events, %d turns; want 5, 5", pass, n, turns)
		}
	}
	var spend float64
	if err := db.QueryRow(`SELECT COALESCE(SUM(cost_usd), 0) FROM daily_stats`).Scan(&spend); err != nil {
		t.Fatal(err)
	}
	var rowSpend float64
	if err := db.QueryRow(`SELECT COALESCE(SUM(cost_usd), 0) FROM events JOIN sessions USING (sid) WHERE session_id = 's2'`).Scan(&rowSpend); err != nil {
		t.Fatal(err)
	}
	if spend != rowSpend {
		t.Fatalf("daily spend %v, the events' %v: a re-recorded batch was counted twice", spend, rowSpend)
	}
}

// An event that fails inside a batch is undone alone: the events around it
// commit, as they would have one transaction each.
func TestAFailedEventInABatchIsUndoneAlone(t *testing.T) {
	r, _, _ := fileRecorder(t)
	ctx := context.Background()
	b := r.Batch(ctx)
	if _, err := b.Record(ctx, batchTurn("s3", 0), SessionInfo{}); err != nil {
		t.Fatal(err)
	}
	bad := batchTurn("", 1) // no session: InsertEvent refuses it
	if _, err := b.Record(ctx, bad, SessionInfo{}); err == nil {
		t.Fatal("an event without a session was accepted")
	}
	if _, err := b.Record(ctx, batchTurn("s3", 2), SessionInfo{}); err != nil {
		t.Fatal(err)
	}
	if stored, _, err := b.Flush(); err != nil || stored != 2 {
		t.Fatalf("flush = %d stored, %v; want 2", stored, err)
	}
	if n, turns := countRows(t, r.Store.DB(), "s3"); n != 2 || turns != 2 {
		t.Fatalf("%d events, %d turns; want 2, 2", n, turns)
	}
}

// A database locked by another process fails the batch with a busy error the
// importers retry on, and the same batch works once the lock is gone.
func TestABusyDatabaseFailsTheBatchRetryably(t *testing.T) {
	r, _, path := fileRecorder(t)
	ctx := context.Background()
	r.Store.DB().SetMaxOpenConns(1)
	if _, err := r.Store.DB().ExecContext(ctx, `PRAGMA busy_timeout = 20`); err != nil {
		t.Fatal(err)
	}
	holder, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Close()
	conn, err := holder.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, `BEGIN IMMEDIATE`); err != nil {
		t.Fatal(err)
	}
	b := r.Batch(ctx)
	if _, err := b.Record(ctx, batchTurn("s4", 0), SessionInfo{}); !store.IsBusy(err) {
		t.Fatalf("record under a held lock: %v, want a busy error", err)
	}
	if b.Open() {
		t.Fatal("a batch that could not begin holds a transaction")
	}
	if _, err := conn.ExecContext(ctx, `ROLLBACK`); err != nil {
		t.Fatal(err)
	}
	if _, err := b.Record(ctx, batchTurn("s4", 0), SessionInfo{}); err != nil {
		t.Fatal(err)
	}
	if stored, _, err := b.Flush(); err != nil || stored != 1 {
		t.Fatalf("flush = %d stored, %v", stored, err)
	}
}

// A live hook event is not held up by a large import: an open batch commits
// as soon as a writer is waiting, so the hook waits for one event and one
// commit, never for the import's own limits (the shim's one second budget,
// rule 3, however long the import runs).
//
// What is proven is the ordering, not a wall-clock time: on a shared CI disk
// one SQLite COMMIT has taken 12.5 s (windows-latest, 2026-10-23), which says
// nothing about the batch. The import's limits are unbounded here, so only a
// waiting writer can end a batch; each hook is sent while a batch holds the
// lock, and the importer checks after every event that a waiting writer makes
// the batch due. A batch that ignored a waiter would make the hook wait for
// the whole import; that is caught at the first event, without a hang.
func TestAHookIsNotDelayedByABackfill(t *testing.T) {
	r, _, _ := fileRecorder(t)
	ctx, stop := context.WithCancel(context.Background())
	var wg sync.WaitGroup
	wg.Add(1)
	var (
		imported   atomic.Int64
		inBatch    atomic.Int64 // events in the open batch, 0 when none is open
		stepAsides atomic.Int64 // batches committed because a writer waited
		ignored    atomic.Int64 // events a batch took with a writer waiting, staying open
	)
	go func() {
		defer wg.Done()
		b := r.Batch(ctx)
		b.MaxEvents, b.MaxAge = 1<<30, time.Hour // only a waiting writer can end a batch
		defer b.Abort()
		for i := 0; ctx.Err() == nil; i++ {
			if _, err := b.Record(ctx, batchTurn("backfill", i), SessionInfo{Cwd: "/p"}); err != nil {
				return
			}
			imported.Add(1)
			inBatch.Add(1)
			// The batch holds the lock, so a writer counted as waiting stays
			// waiting until the batch commits: Due must say so now.
			waiter := r.waiting.Load() > 0
			due := b.Due()
			switch {
			case waiter && due:
				stepAsides.Add(1)
			case waiter:
				ignored.Add(1)
				due = true // commit anyway, so the hook is not left waiting
			}
			if due {
				inBatch.Store(0)
				if _, _, err := b.Flush(); err != nil {
					return
				}
			}
		}
		_, _, _ = b.Flush()
	}()
	// awaitBatch waits until the import holds an open batch, so the next hook
	// is certain to wait behind it.
	awaitBatch := func(i int) {
		t.Helper()
		deadline := time.Now().Add(30 * time.Second)
		for inBatch.Load() == 0 {
			if time.Now().After(deadline) {
				t.Fatalf("hook %d: the import never opened a batch", i)
			}
			time.Sleep(time.Millisecond)
		}
	}
	const hooks = 20
	var worst time.Duration
	for i := 0; i < hooks; i++ {
		awaitBatch(i)
		ev := &event.Event{SessionID: "live", Source: event.SourceHook, Kind: event.KindToolPre, Tool: "Bash",
			Key: fmt.Sprintf("hook-%d", i), Payload: []byte(`{"tool_input":{"command":"ls"}}`)}
		start := time.Now()
		res, err := r.Record(ctx, ev, SessionInfo{Cwd: "/p"})
		worst = max(worst, time.Since(start))
		if err != nil || !res.Stored {
			t.Fatalf("hook %d: stored=%v err=%v", i, res.Stored, err)
		}
	}
	stop()
	wg.Wait()
	if n := ignored.Load(); n > 0 {
		t.Fatalf("a batch took %d events while a hook waited for it, instead of committing", n)
	}
	// Every hook was sent behind an open batch, and every one ended a batch
	// (more than one when the import took the lock back first).
	if n := stepAsides.Load(); n < hooks {
		t.Fatalf("%d batches stepped aside for %d hooks sent behind them", n, hooks)
	}
	if n, _ := countRows(t, r.Store.DB(), "live"); n != hooks {
		t.Fatalf("%d hook events visible, want %d", n, hooks)
	}
	t.Logf("worst hook latency %v beside %d imported events, %d step-asides", worst, imported.Load(), stepAsides.Load())
}

// A writer outside the recorder — a project added from the dashboard — still
// gets the database during a long import. It waits in SQLite's busy handler,
// not on the recorder's lock, so batches back to back must leave it gaps.
func TestAnotherWriterLandsDuringABackfill(t *testing.T) {
	r, _, _ := fileRecorder(t)
	ctx, stop := context.WithCancel(context.Background())
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		b := r.Batch(ctx)
		defer b.Abort()
		for i := 0; ctx.Err() == nil; i++ {
			if _, err := b.Record(ctx, batchTurn("backfill", i), SessionInfo{Cwd: "/p"}); err != nil {
				return
			}
			if b.Due() {
				if _, _, err := b.Flush(); err != nil {
					return
				}
			}
		}
	}()
	defer func() {
		stop()
		wg.Wait()
	}()
	time.Sleep(50 * time.Millisecond)
	for i := 0; i < 10; i++ {
		start := time.Now()
		if _, err := r.Store.DB().ExecContext(context.Background(),
			`INSERT INTO meta(k, v) VALUES(?, 'x') ON CONFLICT(k) DO UPDATE SET v = excluded.v`, fmt.Sprintf("probe-%d", i)); err != nil {
			t.Fatalf("write %d beside the import: %v", i, err)
		}
		if d := time.Since(start); d > 2*time.Second {
			t.Fatalf("write %d waited %v beside the import", i, d)
		}
	}
}

// A backfill reads many transcripts at once, one batch each. A batch already
// queued on the lock when the last one committed took it straight away, so
// the quarter meant to be left free never was, and a write from the dashboard
// (a memory kept in the Brain) ran out of busy_timeout: POST /v1/brain/nodes
// answered SQLITE_BUSY for 252 of 300 memories on the measuring stand,
// 2026-10-19.
func TestAnotherWriterLandsBesideManyBatches(t *testing.T) {
	r, _, _ := fileRecorder(t)
	ctx, stop := context.WithCancel(context.Background())
	var wg sync.WaitGroup
	for g := 0; g < 6; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			b := r.Batch(ctx)
			defer b.Abort()
			for i := 0; ctx.Err() == nil; i++ {
				if _, err := b.Record(ctx, batchTurn(fmt.Sprintf("backfill-%d", g), i), SessionInfo{Cwd: "/p"}); err != nil {
					return
				}
				if b.Due() {
					if _, _, err := b.Flush(); err != nil {
						return
					}
				}
			}
		}(g)
	}
	defer func() {
		stop()
		wg.Wait()
	}()
	time.Sleep(100 * time.Millisecond)
	var worst time.Duration
	for i := 0; i < 50; i++ {
		start := time.Now()
		err := r.Store.WithTx(context.Background(), func(q store.Querier) error {
			for j := 0; j < 3; j++ {
				if _, err := q.ExecContext(context.Background(),
					`INSERT INTO meta(k, v) VALUES(?, 'x') ON CONFLICT(k) DO UPDATE SET v = excluded.v`, fmt.Sprintf("probe-%d-%d", i, j)); err != nil {
					return err
				}
			}
			return nil
		})
		if err != nil {
			t.Fatalf("write %d beside the import: %v", i, err)
		}
		if d := time.Since(start); d > worst {
			worst = d
		}
	}
	t.Logf("worst wait %v", worst)
	if worst > time.Second {
		t.Fatalf("a write waited %v beside the import", worst)
	}
}
