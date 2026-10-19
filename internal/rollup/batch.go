package rollup

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/store"
)

// Batch limits. A first import of 181k events spent half the daemon's CPU on
// one transaction per event (F7 in docs/resource-usage-audit-2026-10-18.md);
// these bound how long one batch holds the write lock, and with it how long a
// live writer can wait behind it.
const (
	BatchMaxEvents = 512
	BatchMaxAge    = 50 * time.Millisecond
)

// Batch writes many events in one transaction, for importers reading history
// (the transcript tailer, the Codex importer). Live hook events never go
// through a batch: they use Record, and an open batch commits and steps aside
// as soon as one is waiting (Due).
//
// Each event is written under its own savepoint, so an event that fails is
// undone alone and the batch goes on, exactly as a failed Record would leave
// the events before it. Nothing is published, and no OnPriced runs, until
// Flush commits: a rolled-back batch has announced nothing, counted nothing
// and moved no offset that the caller writes through Exec.
//
// A Batch belongs to one goroutine, and while it is open (between the first
// write and Flush or Abort) that goroutine must not call Record, which would
// wait on the lock the batch holds.
type Batch struct {
	r    *Recorder
	ctx  context.Context // never cancelled: see Record
	conn *sql.Conn       // holds the open transaction; nil when there is none

	began   time.Time
	n       int
	stored  int
	deduped int
	priced  bool
	pending []Result
	// updates are stored turns whose prose a duplicate line grew, announced
	// after the commit as "event_update" frames.
	updates []*event.Event

	// MaxEvents and MaxAge override BatchMaxEvents and BatchMaxAge.
	MaxEvents int
	MaxAge    time.Duration
}

// Batch starts a batch. Nothing is written until the first Record or Exec.
func (r *Recorder) Batch(ctx context.Context) *Batch {
	return &Batch{r: r, ctx: context.WithoutCancel(ctx), MaxEvents: BatchMaxEvents, MaxAge: BatchMaxAge}
}

// Open reports whether the batch holds a transaction.
func (b *Batch) Open() bool { return b.conn != nil }

// Due reports whether the batch should be committed now: it is full, it has
// held the write lock long enough, or a live writer is waiting for it.
// Callers check it between units they can resume from (a transcript line).
func (b *Batch) Due() bool {
	if b.conn == nil {
		return false
	}
	return b.n >= b.MaxEvents || time.Since(b.began) >= b.MaxAge || b.r.waiting.Load() > 0
}

func (b *Batch) begin() error {
	if b.conn != nil {
		return nil
	}
	// The database's other writers — a project added from the dashboard, a
	// meta value — do not take writeMu; they wait in SQLite's busy handler,
	// which retries on its own schedule. Batches back to back left them no
	// free moment to land in, and on the measuring stand a project could not
	// be created for five seconds and failed. So each batch leaves the lock
	// free for a quarter of the time the previous one held it.
	//
	// The wait is checked again once the lock is held. A backfill reads many
	// transcripts at once, a batch each, and a batch already queued on the
	// lock when the last one committed was handed it at once: the quarter was
	// never free, and a memory kept in the Brain during a backfill failed
	// with SQLITE_BUSY after five seconds (2026-10-19).
	for {
		if wait := time.Until(time.Unix(0, b.r.batchFreeAt.Load())); wait > 0 {
			time.Sleep(wait)
		}
		// Not lockWrite: only a live writer makes an open batch step aside;
		// two importers that did would end each other's batches after every
		// event.
		b.r.writeMu.Lock()
		if time.Now().UnixNano() >= b.r.batchFreeAt.Load() {
			break
		}
		b.r.writeMu.Unlock()
	}
	conn, err := b.r.Store.DB().Conn(b.ctx)
	if err != nil {
		b.r.writeMu.Unlock()
		return err
	}
	// Each event's savepoint keeps a statement journal of the pages it
	// changes. SQLite keeps that journal in memory only up to 64 KiB and then
	// in a temporary file; one event touches more than that, and once spilled
	// the file is never truncated while the transaction lasts, so every page
	// write of the batch was also a write() to it: 46% of an import's CPU,
	// measured 2026-10-18. With temp_store MEMORY the journal stays in memory
	// and is emptied as each savepoint is released. Set on this connection
	// for the batch only, so other queries' sorts and temporary tables still
	// spill to disk.
	if _, err := conn.ExecContext(b.ctx, `PRAGMA temp_store = MEMORY`); err != nil {
		_ = conn.Close()
		b.r.writeMu.Unlock()
		return err
	}
	// The transaction is spelled out on the connection rather than taken from
	// BeginTx: database/sql gives a *sql.Tx a context it can cancel, and starts
	// a goroutine to watch it for every query run inside — four or five per
	// recorded event, the "goroutine per statement" of F15.
	if _, err := conn.ExecContext(b.ctx, `BEGIN IMMEDIATE`); err != nil {
		b.release(conn)
		return err
	}
	b.conn, b.began = conn, time.Now()
	return nil
}

// release returns the batch's connection to the pool as it found it and lets
// the next writer in.
func (b *Batch) release(conn *sql.Conn) {
	_, _ = conn.ExecContext(b.ctx, `PRAGMA temp_store = DEFAULT`)
	_ = conn.Close()
	if !b.began.IsZero() {
		b.r.batchFreeAt.Store(time.Now().Add(time.Since(b.began) / 4).UnixNano())
	}
	b.r.writeMu.Unlock()
}

// step runs fn under a savepoint, undoing only fn's writes when it fails.
func (b *Batch) step(fn func(q store.Querier) error) error {
	if err := b.begin(); err != nil {
		return err
	}
	if _, err := b.conn.ExecContext(b.ctx, `SAVEPOINT ev`); err != nil {
		return err
	}
	if err := fn(b.conn); err != nil {
		if _, rbErr := b.conn.ExecContext(b.ctx, `ROLLBACK TO ev`); rbErr != nil {
			return errors.Join(err, rbErr)
		}
		_, _ = b.conn.ExecContext(b.ctx, `RELEASE ev`)
		return err
	}
	_, err := b.conn.ExecContext(b.ctx, `RELEASE ev`)
	return err
}

// Record writes one event into the batch, as Record would on its own. The
// Result's Stored says what the batch will hold once it commits.
func (b *Batch) Record(ctx context.Context, ev *event.Event, info SessionInfo) (Result, error) {
	r := b.r
	if r.OnWrite != nil {
		r.OnWrite()
	}
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}
	var res Result
	internalModel, priced := r.prepare(ev, info)
	res.Priced = priced
	dup := false
	err := b.step(func(q store.Querier) error {
		err := r.apply(b.ctx, q, ev, info, internalModel, &res)
		if errors.Is(err, store.ErrDuplicate) {
			dup = true
			upd, err := afterDuplicate(b.ctx, q, ev)
			if upd != nil && !internalModel {
				b.updates = append(b.updates, upd)
			}
			return err
		}
		return err
	})
	switch {
	case errors.Is(err, store.ErrRemovedSession):
		return Result{}, nil
	case err != nil:
		return Result{}, err
	case dup:
		b.n++
		b.deduped++
		res.Stored = false
		return res, nil
	}
	b.n++
	b.stored++
	b.priced = b.priced || res.Priced
	res.Event = *ev
	if !internalModel {
		b.pending = append(b.pending, res)
	}
	return res, nil
}

// Exec runs fn inside the batch's transaction under its own savepoint, for a
// write that must commit with the events: a transcript's offset, its title.
func (b *Batch) Exec(fn func(ctx context.Context, q store.Querier) error) error {
	return b.step(func(q store.Querier) error { return fn(b.ctx, q) })
}

// Flush commits the batch and then publishes what it stored. It returns how
// many events the commit stored and how many were already there. After a
// failed commit nothing was stored and nothing is published. The batch can be
// used again after Flush.
func (b *Batch) Flush() (stored, deduped int, err error) {
	if b.conn == nil {
		return 0, 0, nil
	}
	if _, err = b.conn.ExecContext(b.ctx, `COMMIT`); err != nil {
		_, _ = b.conn.ExecContext(b.ctx, `ROLLBACK`)
	}
	b.release(b.conn)
	b.conn = nil
	pending, priced, updates := b.pending, b.priced, b.updates
	stored, deduped = b.stored, b.deduped
	b.reset()
	if err != nil {
		return 0, 0, err
	}
	b.r.publishBatch(pending)
	for _, upd := range updates {
		b.r.publishUpdate(upd, false)
	}
	if priced && b.r.OnPriced != nil {
		b.r.OnPriced(b.ctx)
	}
	return stored, deduped, nil
}

// Abort rolls back whatever the batch holds. It is safe to call at any time,
// and after Flush it does nothing.
func (b *Batch) Abort() {
	if b.conn == nil {
		return
	}
	_, _ = b.conn.ExecContext(b.ctx, `ROLLBACK`)
	b.release(b.conn)
	b.conn = nil
	b.reset()
}

func (b *Batch) reset() {
	b.n, b.stored, b.deduped, b.priced, b.pending, b.updates = 0, 0, 0, false, nil, nil
}

// publishBatch sends every committed event's frame, in order, and one session
// frame per session with its state after the last of them: a session's
// intermediate states during an import are already history when they arrive.
func (r *Recorder) publishBatch(pending []Result) {
	if r.Bus == nil || len(pending) == 0 {
		return
	}
	last := make(map[string]int, 4)
	order := make([]string, 0, 4)
	for i, res := range pending {
		r.Bus.Publish(busEvent(res.Event))
		id := res.Event.SessionID
		if _, ok := last[id]; !ok {
			order = append(order, id)
		}
		last[id] = i
	}
	for _, id := range order {
		res := pending[last[id]]
		r.Bus.Publish(busSession(res))
	}
}
