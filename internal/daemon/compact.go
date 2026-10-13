package daemon

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"sync/atomic"
	"time"

	"github.com/shirou/gopsutil/v4/disk"

	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/store"
)

// Making the database smaller on its own, while nobody is working.
//
// Three steps, each only after the daemon has been idle for idleFor, each
// standing down the moment something is to be recorded:
//
//  1. **Payload compaction** (store.CompactPayloadsStep): rows stored before
//     event.CapToolField still hold screenshots as base64; they get the
//     marker new rows get. A few hundred ids per step, a short pause between
//     steps, resumable, finished once.
//  2. **One VACUUM**, after the compaction: it gives the freed pages back to
//     the disk and switches the database to auto_vacuum=INCREMENTAL. Only with
//     the disk to spare (vacuumRoom) and under a time limit; a write that
//     arrives meanwhile interrupts it, and an interrupted VACUUM changes
//     nothing. Tried again a day later if it could not run or finish.
//  3. **Incremental vacuum** from then on: free pages — from the retention
//     prune, from rows that shrank — are given back a few megabytes at a
//     time.
//
// Each step that did something is said in the footprint's actions
// (`caprock doctor`) and logged.
const (
	// compactWindow is how many event ids one compaction step examines.
	compactWindow = 500
	// compactPause is the rest between two steps, so ingest and the
	// dashboard's reads always find the database free within it.
	compactPause = 50 * time.Millisecond
	// vacuumTimeout bounds the one VACUUM. On a copy of the owner's 2.2 GB
	// database, compacted first, it took 21 s (2026-10-13); one that runs
	// past this is interrupted, leaves the database as it was, and is tried
	// again a day later.
	vacuumTimeout = 10 * time.Minute
	// vacuumRetry is how long after a VACUUM that could not run or finish
	// it is tried again.
	vacuumRetry = 24 * time.Hour
	// incrementalStep is how many free pages one incremental_vacuum returns:
	// 4 MiB at the default 4 KiB page.
	incrementalStep = 1024
	// incrementalMin is the freelist below which the incremental vacuum does
	// not bother: new rows reuse that much within the hour.
	incrementalMin = 8 << 20
)

// vacuumRoom is the free disk a VACUUM of a database holding used bytes
// needs, on the data directory's volume and on the temporary directory's.
// SQLite copies the database to a temporary file, then writes every page back
// through the write-ahead log: a second copy in each, both live at the peak.
// With the temporary directory on the same volume that is twice the used
// size — measured 2,777 MB of extra disk at the peak for 1,430 MB in use, on
// a copy of the owner's database (2026-10-13) — and ten percent on top is the
// margin.
func vacuumRoom(used int64) (dataVol, tempVol int64) {
	return used * 22 / 10, used * 11 / 10
}

// freeSpace is the free bytes on the volume that holds path, as the user
// sees them (not the root reserve). It is a variable for tests.
var freeSpace = func(path string) (int64, error) {
	u, err := disk.Usage(path)
	if err != nil {
		return 0, err
	}
	return int64(min(u.Free, uint64(1)<<62)), nil
}

// writeGate is how the idle-time database work knows a write is wanted: the
// recorder and every API request that may write call want(), and a running
// VACUUM is interrupted by it.
type writeGate struct {
	last   atomic.Int64 // unix ms of the last want
	cancel atomic.Pointer[context.CancelFunc]
}

func (g *writeGate) want() {
	g.last.Store(time.Now().UnixMilli())
	if c := g.cancel.Load(); c != nil {
		(*c)()
	}
}

// guard returns a context cancelled by the next want, and its release.
func (g *writeGate) guard(ctx context.Context) (context.Context, func()) {
	ctx, cancel := context.WithCancel(ctx)
	g.cancel.Store(&cancel)
	return ctx, func() {
		g.cancel.Store(nil)
		cancel()
	}
}

// markWrites tells the write gate about every request that may write: any
// method but GET, HEAD and OPTIONS. The dashboard polls with GET all the
// time, which reads under WAL and is never held up by a VACUUM.
func (d *Daemon) markWrites(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
		default:
			d.writes.want()
		}
		h.ServeHTTP(w, r)
	})
}

// quiet reports whether nothing has been recorded or asked to be written for
// idleFor.
func (d *Daemon) quiet(now time.Time) bool {
	last := max(d.activity.Load(), d.writes.last.Load())
	return now.Sub(time.UnixMilli(last)) >= idleFor
}

// compactState is what the idle-time database work remembers between runs.
type compactState struct {
	vacuumTried time.Time
	roomWarned  bool
}

// compactDB runs the three steps as far as the quiet lasts.
func (d *Daemon) compactDB(ctx context.Context, cs *compactState) {
	if !d.compactPayloads(ctx) {
		return
	}
	mode, err := d.store.AutoVacuum(ctx)
	if err != nil {
		return
	}
	if mode != store.AutoVacuumIncremental {
		if time.Since(cs.vacuumTried) >= vacuumRetry && d.quiet(time.Now()) {
			cs.vacuumTried = time.Now()
			d.vacuumOnce(ctx, cs)
		}
		return
	}
	d.incrementalVacuum(ctx)
}

// compactPayloads runs compaction steps while the daemon stays quiet and
// reports whether the compaction is finished.
func (d *Daemon) compactPayloads(ctx context.Context) bool {
	if done, err := d.store.PayloadCompactFinished(ctx); err != nil || done {
		return err == nil
	}
	start := time.Now()
	var rows int
	var freed int64
	done := false
	for ctx.Err() == nil && d.quiet(time.Now()) {
		st, err := d.store.CompactPayloadsStep(ctx, compactWindow)
		if err != nil {
			if ctx.Err() == nil {
				d.log.Warn("payload compaction step failed; tried again when idle", "component", "daemon", "err", err)
			}
			break
		}
		rows += st.Rewritten
		freed += st.Freed
		if st.Done {
			done = true
			break
		}
		select {
		case <-ctx.Done():
		case <-time.After(compactPause):
		}
	}
	if rows > 0 {
		d.actions.add(compactAction(rows, freed, done))
	}
	if rows > 0 || done {
		d.log.Info("compacted stored payloads", "component", "daemon",
			"rows", rows, "freed_bytes", freed, "done", done, "took", time.Since(start).Round(time.Millisecond))
	}
	return done
}

// compactAction is the footprint's line for a compaction run.
func compactAction(rows int, freed int64, done bool) string {
	s := "replaced the base64 images and files in " + plural(rows, "older event") +
		" with markers (" + Bytes(uint64(max(freed, 0))) + " of payload)"
	if done {
		return s + "; every older event is done"
	}
	return s + "; continues the next time Caprock is idle"
}

// vacuumOnce runs the VACUUM that switches the database to incremental
// vacuuming, when the disk has room for it.
func (d *Daemon) vacuumOnce(ctx context.Context, cs *compactState) {
	before, err := d.store.Pages(ctx)
	if err != nil {
		return
	}
	used := before.Bytes() - before.FreeBytes()
	needData, needTemp := vacuumRoom(used)
	freeData, errData := freeSpace(d.opt.DataDir)
	freeTemp, errTemp := freeSpace(os.TempDir())
	if errData != nil || errTemp != nil || freeData < needData || freeTemp < needTemp {
		if !cs.roomWarned {
			cs.roomWarned = true
			d.actions.add(fmt.Sprintf("did not compact the database: it needs %s of free disk for a moment, and %s is free; tried again daily",
				Bytes(uint64(needData)), Bytes(uint64(max(min(freeData, freeTemp), 0)))))
		}
		d.log.Info("database not compacted: not enough free disk", "component", "daemon",
			"need", needData, "free", freeData, "need_temp", needTemp, "free_temp", freeTemp, "err_data", errData, "err_temp", errTemp)
		return
	}
	wal := config.DBPath(d.opt.DataDir) + "-wal"
	start := time.Now()
	vctx, cancel := context.WithTimeout(ctx, vacuumTimeout)
	defer cancel()
	vctx, release := d.writes.guard(vctx)
	err = d.store.EnableIncrementalVacuum(vctx)
	release()
	took := time.Since(start).Round(time.Second)
	if err != nil {
		why := "it failed"
		switch {
		case ctx.Err() != nil:
			return
		case errors.Is(vctx.Err(), context.DeadlineExceeded):
			why = fmt.Sprintf("it ran past %d minutes", int(vacuumTimeout/time.Minute))
		case vctx.Err() != nil:
			why = "something was to be recorded"
		}
		d.actions.add("stopped compacting the database after " + took.String() + " because " + why + "; nothing changed, tried again tomorrow")
		d.log.Info("database compaction stopped", "component", "daemon", "why", why, "took", took, "err", err)
		return
	}
	walPeak := int64(0)
	if st, err := os.Stat(wal); err == nil {
		walPeak = st.Size()
	}
	_, _ = d.store.CheckpointTruncate(ctx)
	after, _ := d.store.Pages(ctx)
	freed := before.Bytes() - after.Bytes()
	d.actions.add(fmt.Sprintf("compacted the database: %s to %s (%s freed) in %s; from now on free space is given back as it appears",
		Bytes(uint64(before.Bytes())), Bytes(uint64(after.Bytes())), Bytes(uint64(max(freed, 0))), took))
	d.log.Info("database compacted", "component", "daemon",
		"before", before.Bytes(), "after", after.Bytes(), "freed", freed, "took", took, "wal_peak", walPeak)
}

// incrementalVacuum gives the freelist back to the disk a step at a time,
// while the daemon stays quiet.
func (d *Daemon) incrementalVacuum(ctx context.Context) {
	p, err := d.store.Pages(ctx)
	if err != nil || p.FreeBytes() < incrementalMin {
		return
	}
	var pages int64
	for ctx.Err() == nil && d.quiet(time.Now()) {
		n, err := d.store.IncrementalVacuum(ctx, incrementalStep)
		if err != nil || n == 0 {
			break
		}
		pages += n
		if n < incrementalStep {
			break
		}
		select {
		case <-ctx.Done():
		case <-time.After(compactPause):
		}
	}
	if pages == 0 {
		return
	}
	_, _ = d.store.CheckpointTruncate(ctx)
	freed := pages * p.PageSize
	d.actions.add("gave " + Bytes(uint64(freed)) + " of free space inside the database back to the disk")
	d.log.Info("returned free pages to the disk", "component", "daemon", "pages", pages, "freed_bytes", freed)
}
