package daemon

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/dspv/caprock/internal/store"
)

// Compressed tool output, the daemon's part (ADR-093; store/zpayload.go has
// the format and the steps).
//
// Never at start, never on the write path: one step at a time from the
// background job (maintain.go), only after writes have paused for calmFor,
// yielding to any write that arrives during it, resting nine times as long
// as it took. A step reads a window of rows outside any transaction and
// writes the ones that changed in one short one, so a hook waits at most
// that long for the write lock — and not even that, since a write that wants
// the database interrupts the step, which then changes nothing.
//
// It used to wait for 30 minutes with nothing recorded. On the owner's
// machine, where agents run around the clock, that never came: the setting
// was on all night and compressed nothing (2026-11-07).
const (
	// zstdWindow is how many event ids one step examines. On a copy of the
	// owner's database (2026-11-07) a step took 27 ms on average, 50 ms at
	// the 95th percentile and 98 ms at most: 552,525 rows in 1,773 steps.
	zstdWindow = 500
	// zstdRestoreMargin is the free disk restoring keeps beyond what the
	// restored rows will take.
	zstdRestoreMargin = 512 << 20
	// zstdRecheck is how long a finished compression pass rests before it
	// looks for rows that have turned a day old since.
	zstdRecheck = 10 * time.Minute
	// zstdLag is how far past the day the next row to compress may be before
	// the job counts as under way again (CompressionReport.Pending).
	zstdLag = time.Hour
	// metaRestoreFrom is the cursor when restoring began, so the sidebar can
	// say how far it has come. Removed when restoring finishes.
	metaRestoreFrom = "payload_zstd_restore_from"
)

// zstdStep runs one step of compression with the setting on, or of restoring
// with it off. It reports whether it did a step; false means there is
// nothing to do in that direction now.
func (d *Daemon) zstdStep(ctx context.Context, ms *maintainState) (bool, error) {
	if d.config().CompressToolOutputOn() {
		if time.Now().Before(ms.zstdRestUntil) {
			return false, nil
		}
		// The Tools screen reads a call's fields from its payload until
		// tool_fields holds them, through an index on the payload's JSON.
		if ok, err := d.store.ToolFieldsFilled(ctx); err != nil || !ok {
			return false, err
		}
		now := time.Now()
		st, err := d.store.CompressPayloadsStep(ctx, zstdWindow, now.Add(-store.CompressAge).UnixMilli(), now.UnixMilli())
		if err != nil {
			return false, err
		}
		ms.zstd.add(true, st.Rows, st.Bytes)
		if st.Done {
			ms.zstdRestUntil = now.Add(zstdRecheck)
			d.zstdFinished(ctx, ms, true)
		}
		return true, nil
	}
	ms.zstdRestUntil = time.Time{}
	cur, err := d.store.PayloadZstdCursor(ctx)
	if err != nil || cur == 0 {
		return false, err
	}
	// Restoring makes the file larger by what compression saved; it needs the
	// disk for it. The saved total is an upper bound (rows deleted since are
	// still in it), which is the safe side for this check.
	saved, err := d.store.PayloadZstdSaved(ctx)
	if err != nil {
		return false, err
	}
	need := saved + zstdRestoreMargin
	free, ferr := freeSpace(d.opt.DataDir)
	if ferr != nil || free < need {
		if !ms.restoreWarned {
			ms.restoreWarned = true
			d.actions.add(fmt.Sprintf("did not restore the compressed tool output: it needs about %s of free disk, and %s is free; tried again later",
				Bytes(uint64(need)), Bytes(uint64(max(free, 0)))))
			d.log.Info("compressed tool output not restored: not enough free disk", "component", "daemon", "need", need, "free", free, "err", ferr)
		}
		return false, nil
	}
	ms.restoreWarned = false
	if v, _ := d.store.GetMeta(ctx, metaRestoreFrom); v == "" {
		_ = d.store.SetMeta(ctx, metaRestoreFrom, strconv.FormatInt(cur, 10))
	}
	st, err := d.store.DecompressPayloadsStep(ctx, zstdWindow)
	if err != nil {
		return false, err
	}
	ms.zstd.add(false, st.Rows, st.Bytes)
	if st.Done {
		d.zstdFinished(ctx, ms, false)
	}
	return true, nil
}

// zstdTally is what the job did since it last said so.
type zstdTally struct {
	compress bool
	rows     int
	bytes    int64
	start    time.Time
}

func (t *zstdTally) add(compress bool, rows int, bytes int64) {
	if t.rows > 0 && t.compress != compress {
		t.rows, t.bytes = 0, 0
	}
	if t.rows == 0 {
		t.start = time.Now()
	}
	t.compress = compress
	t.rows += rows
	t.bytes += bytes
}

// zstdSay puts what the job did since it last said so in the footprint and
// the log, and starts counting again.
func (d *Daemon) zstdSay(ms *maintainState, done bool) {
	t := &ms.zstd
	if t.rows == 0 {
		return
	}
	d.actions.add(zstdAction(t.compress, t.rows, t.bytes, done))
	d.log.Info("tool output compression", "component", "daemon", "compress", t.compress,
		"rows", t.rows, "bytes", t.bytes, "done", done, "took", time.Since(t.start).Round(time.Millisecond))
	t.rows, t.bytes = 0, 0
}

// zstdFinished closes a pass in one direction.
func (d *Daemon) zstdFinished(ctx context.Context, ms *maintainState, compress bool) {
	had := ms.zstd.rows > 0
	d.zstdSay(ms, true)
	if !compress {
		_ = d.store.SetMeta(ctx, store.MetaPayloadZstdRepacked, "0")
		_, _ = d.store.DB().ExecContext(ctx, `DELETE FROM meta WHERE k = ?`, metaRestoreFrom)
	}
	if !had {
		return
	}
	// The Storage panel's figures are a day old at most; the step that
	// finished the pass makes them stale at once.
	d.storage.mu.Lock()
	d.storage.tried = time.Time{}
	d.storage.mu.Unlock()
	d.packEstimateStale()
}

// zstdRepackMin is how much compression must have saved since the last
// repack before another is worth a VACUUM. Compression shrinks rows in
// place; the overflow pages it frees go back by incremental vacuum, but the
// leaf pages it leaves half empty only a VACUUM packs: on a copy of the
// owner's database, 2,524 MiB became 1,945 MiB with incremental vacuum alone
// and 1,511 MiB after one VACUUM (2026-11-06).
var zstdRepackMin int64 = 256 << 20 // a variable for tests

// zstdRepack runs one VACUUM after a compression pass has finished, when it
// saved at least zstdRepackMin since the last one — in practice once, after
// the first pass, unless the user packed first (pack.go). It is vacuumOnce:
// the same free-disk rule, the same time limit, interrupted by anything that
// wants to write, and tried again a day later when it could not run.
func (d *Daemon) zstdRepack(ctx context.Context, cs *compactState) {
	if !d.config().CompressToolOutputOn() || !d.zstdPassDone(ctx) {
		return
	}
	saved, err := d.store.PayloadZstdSaved(ctx)
	if err != nil {
		return
	}
	v, err := d.store.GetMeta(ctx, store.MetaPayloadZstdRepacked)
	if err != nil {
		return
	}
	last, _ := strconv.ParseInt(v, 10, 64)
	if saved-last < zstdRepackMin || time.Since(cs.repackTried) < vacuumRetry || !d.quiet(time.Now()) {
		return
	}
	cs.repackTried = time.Now()
	if d.vacuumOnce(ctx, cs) {
		_ = d.store.SetMeta(ctx, store.MetaPayloadZstdRepacked, strconv.FormatInt(saved, 10))
		d.packEstimateStale()
	}
}

// zstdPassDone reports whether the compression job has caught up with the
// rows turning a day old: nothing is left to compress but what the next
// look finds.
func (d *Daemon) zstdPassDone(ctx context.Context) bool {
	r := d.compressionReport(ctx)
	return r.On && !r.Pending
}

// zstdAction is the footprint's line for a run.
func zstdAction(compress bool, rows int, bytes int64, done bool) string {
	var s string
	if compress {
		s = "compressed " + plural(rows, "older tool call") + " (" + Bytes(uint64(max(bytes, 0))) + " smaller)"
		if done {
			return s + "; every tool call older than a day is done"
		}
	} else {
		s = "restored " + plural(rows, "compressed tool call") + " to plain JSON (" + Bytes(uint64(max(bytes, 0))) + " larger)"
		if done {
			return s + "; none is compressed now"
		}
	}
	return s + "; continues in the background"
}

// CompressionReport is the switch and where the job is, for GET /v1/storage
// and GET /v1/storage/pack.
type CompressionReport struct {
	On bool `json:"on"`
	// ThroughMs is the time of the newest event the job has passed: tool
	// rows up to it are compressed (on) or still to restore (off). 0 when
	// nothing is compressed.
	ThroughMs int64 `json:"through_ms,omitempty"`
	// Restoring is true while it is off and compressed rows are left.
	Restoring bool `json:"restoring,omitempty"`
	// CursorID is the job's cursor, an event id: every id at or below it
	// has been examined (on) or is still to restore (off).
	CursorID int64 `json:"cursor_id"`
	// TargetID is the id the compression pass has to reach now: the one
	// before the first event younger than a day. Ids, not rows: an id whose
	// row was deleted counts too, so the share is close, not exact (911,345
	// rows over 927,451 ids on the owner's database, 2026-11-07).
	TargetID int64 `json:"target_id"`
	// RestoreFromID is the cursor when restoring began; 0 unless restoring.
	RestoreFromID int64 `json:"restore_from_id,omitempty"`
	// Progress is how far the pass in the current direction is, 0 to 1:
	// CursorID over TargetID while compressing, and how far the cursor
	// has come down from RestoreFromID while restoring.
	Progress float64 `json:"progress"`
	// Pending is true while the job is under way in the current direction:
	// the next row to examine is more than zstdLag past the day (on), or
	// compressed rows are left (off).
	Pending bool `json:"pending"`
	// SavedBytes is the payload bytes compression has saved so far
	// (meta.payload_zstd_saved): an upper bound, since rows deleted since
	// are not taken off.
	SavedBytes int64 `json:"saved_bytes"`
}

func (d *Daemon) compressionReport(ctx context.Context) CompressionReport {
	r := CompressionReport{On: d.config().CompressToolOutputOn()}
	if d.store == nil {
		return r
	}
	cur, err := d.store.PayloadZstdCursor(ctx)
	if err != nil {
		return r
	}
	r.CursorID = cur
	r.SavedBytes, _ = d.store.PayloadZstdSaved(ctx)
	if r.On {
		now := time.Now()
		cutoff := now.Add(-store.CompressAge).UnixMilli()
		// The job stops at the first row younger than a day, in id order; a
		// row stamped over an hour ahead counts as old (store.zstdFuture).
		// The target is the last id before that row which exists: an id
		// deleted since would be one the cursor never lands on.
		_ = d.store.DB().QueryRowContext(ctx, `
			SELECT COALESCE(
			  (SELECT MAX(id) FROM events WHERE id < (SELECT MIN(id) FROM events WHERE ts >= ? AND ts <= ?)),
			  (SELECT MAX(id) FROM events WHERE NOT EXISTS (SELECT 1 FROM events WHERE ts >= ? AND ts <= ?)),
			  0)`,
			cutoff, now.Add(time.Hour).UnixMilli(), cutoff, now.Add(time.Hour).UnixMilli()).Scan(&r.TargetID)
		// Rows turn a day old all the time, so the target is always a little
		// ahead of a finished pass, which looks again every zstdRecheck. The
		// job counts as under way only while the next row it would examine
		// is more than zstdLag past the day: otherwise the sidebar would say
		// "compressing" forever.
		if cur < r.TargetID {
			var next int64
			if err := d.store.DB().QueryRowContext(ctx, `SELECT ts FROM events WHERE id > ? ORDER BY id LIMIT 1`, cur).Scan(&next); err == nil {
				r.Pending = next < cutoff-zstdLag.Milliseconds()
			}
		}
		switch {
		case r.TargetID <= 0:
			r.Progress = 1
		default:
			r.Progress = min(float64(cur)/float64(r.TargetID), 1)
		}
	}
	if cur == 0 {
		if !r.On {
			r.Progress = 1
		}
		return r
	}
	_ = d.store.DB().QueryRowContext(ctx, `SELECT ts FROM events WHERE id <= ? ORDER BY id DESC LIMIT 1`, cur).Scan(&r.ThroughMs)
	if !r.On {
		r.Restoring, r.Pending = true, true
		from, _ := d.store.GetMeta(ctx, metaRestoreFrom)
		r.RestoreFromID, _ = strconv.ParseInt(from, 10, 64)
		if r.RestoreFromID > 0 {
			r.Progress = min(max(1-float64(cur)/float64(r.RestoreFromID), 0), 1)
		}
	}
	return r
}
