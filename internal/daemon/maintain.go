package daemon

import (
	"context"
	"errors"
	"time"

	"github.com/dspv/caprock/internal/store"
)

// The database's short housekeeping steps, run while agents work
// (ADR-093, amended 2026-11-07).
//
// They used to wait, like the VACUUM, for 30 minutes with nothing recorded.
// The owner's agents run around the clock — 300 to 700 events an hour
// overnight, the longest gap 11 minutes — so that never came, and with
// Compress tool output on all night not one row was compressed (2026-11-07).
// A step is short: 27 ms on average for 500 rows of compression, 96 ms for
// 4 MiB of incremental vacuum, on a copy of the owner's database. It needs
// a pause in writes, not an idle machine:
//
//   - **A pause of calmFor.** Nothing recorded and no request that may write
//     for that long.
//   - **It yields.** The step runs on a context the write gate cancels: a
//     hook, a transcript line or a request that may write interrupts it,
//     SQLite rolls it back, and the step is done again at the next pause.
//     Nothing it does is half-written: each step's rows and cursor go in one
//     transaction.
//   - **At most a tenth of one core.** After a step the job rests nine times
//     as long as the step took, so a run of steps is busy for at most 10% of
//     the time, whatever the machine.
//   - **One at a time with the VACUUMs** (dbMu): the idle-time one
//     (compact.go) and the user's (pack.go).
//
// Order: the payload compaction until it has finished, then compression
// (or restoring), and incremental vacuum whenever the freelist is large,
// in between compression steps or after them.
const (
	// calmFor is the pause in writes a step waits for. In the owner's last
	// 24 hours of events (25,197 of them, 2026-11-07) gaps of at least 5 s
	// added up to 14.7 hours after their first 5 s; at 2 s it was 17.3 h,
	// at 10 s 13.0 h, at 30 s 9.2 h, and at 30 minutes none. A turn's hooks
	// and transcript lines come within a second or two of each other, so a
	// pause of 5 s is between turns, or a model thinking, and a step of tens
	// of milliseconds in it delays nobody. A variable for tests.
	calmForDefault = 5 * time.Second
	// dutyRest is the rest after a step, as a multiple of the step's time:
	// 9 keeps the job at or under 10% of one core.
	dutyRest = 9
	// minRest is the shortest rest between two steps.
	minRest = 50 * time.Millisecond
	// maintainRecheck is how long the job sleeps when it has nothing to do.
	maintainRecheck = 5 * time.Minute
	// sayEvery is how often a long run puts what it has done so far in the
	// footprint.
	sayEvery = 30 * time.Minute
	// incrementalBetween is the freelist at which incremental vacuum steps
	// run in between compression steps rather than after the pass.
	incrementalBetween = 64 << 20
)

var calmFor = calmForDefault

// beforeStep, when set, runs inside each step's guard just before the step:
// tests use it to want a write at that moment.
var beforeStep func()

// maintainState is what the background job remembers between steps.
type maintainState struct {
	compactDone bool
	compact     struct {
		rows  int
		freed int64
	}
	zstd zstdTally
	// zstdRestUntil is when a finished compression pass looks again.
	zstdRestUntil time.Time
	// restoreWarned is set once the footprint has said why compressed rows
	// are not being restored (not enough free disk).
	restoreWarned bool
	// incrPages is what incremental vacuum returned since it last said so;
	// incrOn is set while a run of steps is under way.
	incrPages int64
	incrOn    bool
	said      time.Time
	// steps, yielded and busy count what the job did, for tests and the log.
	steps, yielded int
	busy           time.Duration
}

// calm reports whether nothing has been recorded or asked to be written for
// calmFor.
func (d *Daemon) calm(now time.Time) bool {
	return now.Sub(d.lastWrite()) >= calmFor
}

func (d *Daemon) lastWrite() time.Time {
	return time.UnixMilli(max(d.activity.Load(), d.writes.last.Load()))
}

// maintainLoop runs the short steps for as long as the daemon runs.
func (d *Daemon) maintainLoop(ctx context.Context) {
	var ms maintainState
	ms.said = time.Now()
	for ctx.Err() == nil {
		rest := d.maintainOnce(ctx, &ms)
		if !sleepCtx(ctx, rest) {
			break
		}
	}
	d.maintainSay(&ms)
}

// maintainOnce waits for the pause, runs one step, and says how long to rest
// before the next.
func (d *Daemon) maintainOnce(ctx context.Context, ms *maintainState) time.Duration {
	if d.moving() || d.store == nil {
		return maintainRecheck
	}
	now := time.Now()
	if !d.calm(now) {
		// Wake when the pause would be complete, if nothing comes meanwhile.
		return max(d.lastWrite().Add(calmFor).Sub(now), minRest)
	}
	t := time.Now()
	did, yielded := d.maintainStep(ctx, ms)
	took := time.Since(t)
	if yielded {
		ms.yielded++
		return minRest
	}
	if !did {
		d.maintainSay(ms)
		return maintainRecheck
	}
	ms.steps++
	ms.busy += took
	if time.Since(ms.said) >= sayEvery {
		d.maintainSay(ms)
	}
	return max(dutyRest*took, minRest)
}

// maintainStep runs the most pressing step under dbMu, on a context any
// write cancels. It reports whether a step ran, and whether it gave way to
// a write.
func (d *Daemon) maintainStep(ctx context.Context, ms *maintainState) (did, yielded bool) {
	d.dbMu.Lock()
	defer d.dbMu.Unlock()
	gctx, release := d.writes.guard(ctx)
	defer release()
	// A write that came between the check and the guard would not have
	// cancelled anything: look once more.
	if !d.calm(time.Now()) {
		return false, true
	}
	if beforeStep != nil {
		beforeStep()
	}
	var err error
	switch {
	case !ms.compactDone:
		did, err = d.compactStep(gctx, ms)
		if did || err != nil {
			break
		}
		fallthrough
	default:
		if d.freeBytes(gctx) >= incrementalBetween || ms.incrOn {
			if did, err = d.incrementalStep(gctx, ms); did || err != nil {
				break
			}
		}
		if did, err = d.zstdStep(gctx, ms); did || err != nil {
			break
		}
		did, err = d.incrementalStep(gctx, ms)
	}
	if err != nil {
		if gctx.Err() != nil && ctx.Err() == nil {
			return false, true
		}
		if ctx.Err() == nil && !errors.Is(err, context.Canceled) {
			d.log.Warn("database housekeeping step failed; tried again later", "component", "daemon", "err", err)
		}
		return false, false
	}
	return did, false
}

// freeBytes is the freelist, 0 when it cannot be read.
func (d *Daemon) freeBytes(ctx context.Context) int64 {
	p, err := d.store.Pages(ctx)
	if err != nil {
		return 0
	}
	return p.FreeBytes()
}

// compactStep runs one step of the payload compaction.
func (d *Daemon) compactStep(ctx context.Context, ms *maintainState) (bool, error) {
	done, err := d.store.PayloadCompactFinished(ctx)
	if err != nil {
		return false, err
	}
	if done {
		ms.compactDone = true
		return false, nil
	}
	st, err := d.store.CompactPayloadsStep(ctx, compactWindow)
	if err != nil {
		return false, err
	}
	ms.compact.rows += st.Rewritten
	ms.compact.freed += st.Freed
	if st.Done {
		ms.compactDone = true
		d.compactSay(ms, true)
	}
	return true, nil
}

func (d *Daemon) compactSay(ms *maintainState, done bool) {
	if ms.compact.rows == 0 && !done {
		return
	}
	if ms.compact.rows > 0 {
		d.actions.add(compactAction(ms.compact.rows, ms.compact.freed, done))
	}
	d.log.Info("compacted stored payloads", "component", "daemon",
		"rows", ms.compact.rows, "freed_bytes", ms.compact.freed, "done", done)
	ms.compact.rows, ms.compact.freed = 0, 0
}

// incrementalStep gives incrementalStep free pages back to the disk, on a
// database in incremental mode with a freelist worth it.
func (d *Daemon) incrementalStep(ctx context.Context, ms *maintainState) (bool, error) {
	mode, err := d.store.AutoVacuum(ctx)
	if err != nil || mode != store.AutoVacuumIncremental {
		return false, err
	}
	if !ms.incrOn && d.freeBytes(ctx) < incrementalMin {
		return false, nil
	}
	n, err := d.store.IncrementalVacuum(ctx, incrementalStep)
	if err != nil {
		return false, err
	}
	ms.incrPages += n
	ms.incrOn = n >= incrementalStep
	if !ms.incrOn {
		d.incrementalSay(ctx, ms)
	}
	return n > 0, nil
}

func (d *Daemon) incrementalSay(ctx context.Context, ms *maintainState) {
	if ms.incrPages == 0 {
		return
	}
	_, _ = d.store.CheckpointTruncate(ctx)
	p, err := d.store.Pages(ctx)
	if err != nil {
		return
	}
	freed := ms.incrPages * p.PageSize
	ms.incrPages = 0
	d.actions.add("gave " + Bytes(uint64(freed)) + " of free space inside the database back to the disk")
	d.log.Info("returned free pages to the disk", "component", "daemon", "freed_bytes", freed)
	d.packEstimateStale()
}

// maintainSay puts what the running jobs have done so far in the footprint.
func (d *Daemon) maintainSay(ms *maintainState) {
	ms.said = time.Now()
	d.compactSay(ms, false)
	d.zstdSay(ms, false)
	if ms.incrPages > 0 {
		d.incrementalSay(context.WithoutCancel(d.ctxOrBackground()), ms)
	}
}

func (d *Daemon) ctxOrBackground() context.Context {
	if d.baseCtx != nil {
		return d.baseCtx
	}
	return context.Background()
}
