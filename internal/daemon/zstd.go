package daemon

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/dspv/caprock/internal/store"
)

// Compressed tool output, the idle-time part (ADR-093; store/zpayload.go has
// the format and the steps).
//
// Never at start, never on the write path: compactDB calls this only after
// the daemon has been quiet for idleFor, and it stops the moment anything is
// to be recorded or written (quiet is asked before every step). A step reads
// a window of rows outside any transaction and writes the ones that changed
// in one short one, so a hook waits at most that long for the write lock.
// Between steps the job rests twice as long as the step took, so it uses at
// most a third of one core while it runs.
const (
	// zstdWindow is how many event ids one step examines.
	zstdWindow = 500
	// zstdRestoreMargin is the free disk restoring keeps beyond what the
	// restored rows will take.
	zstdRestoreMargin = 512 << 20
)

// zstdPause is the rest after a step that took took.
func zstdPause(took time.Duration) time.Duration {
	return max(compactPause, 2*took)
}

// zstdPayloads compresses older tool payloads while the setting is on, and
// restores compressed ones while it is off, for as long as the quiet lasts.
func (d *Daemon) zstdPayloads(ctx context.Context, cs *compactState) {
	if d.config().CompressToolOutputOn() {
		// The Tools screen reads a call's fields from its payload until
		// tool_fields holds them, through an index on the payload's JSON.
		if ok, err := d.store.ToolFieldsFilled(ctx); err != nil || !ok {
			return
		}
		if d.zstdRun(ctx, true) {
			d.zstdRepack(ctx, cs)
		}
		return
	}
	cur, err := d.store.PayloadZstdCursor(ctx)
	if err != nil || cur == 0 {
		return
	}
	// Restoring makes the file larger by what compression saved; it needs the
	// disk for it. The saved total is an upper bound (rows deleted since are
	// still in it), which is the safe side for this check.
	saved, err := d.store.PayloadZstdSaved(ctx)
	if err != nil {
		return
	}
	need := saved + zstdRestoreMargin
	free, err := freeSpace(d.opt.DataDir)
	if err != nil || free < need {
		if !cs.restoreWarned {
			cs.restoreWarned = true
			d.actions.add(fmt.Sprintf("did not restore the compressed tool output: it needs about %s of free disk, and %s is free; tried again when idle",
				Bytes(uint64(need)), Bytes(uint64(max(free, 0)))))
		}
		d.log.Info("compressed tool output not restored: not enough free disk", "component", "daemon", "need", need, "free", free, "err", err)
		return
	}
	cs.restoreWarned = false
	_ = d.zstdRun(ctx, false)
}

// zstdRun runs steps in one direction while the daemon stays quiet, and
// reports whether the pass in that direction is finished.
func (d *Daemon) zstdRun(ctx context.Context, compress bool) bool {
	start := time.Now()
	var rows int
	var bytes int64
	done := false
	for ctx.Err() == nil && d.quiet(time.Now()) {
		t := time.Now()
		var st store.ZstdStep
		var err error
		if compress {
			now := time.Now()
			st, err = d.store.CompressPayloadsStep(ctx, zstdWindow, now.Add(-store.CompressAge).UnixMilli(), now.UnixMilli())
		} else {
			st, err = d.store.DecompressPayloadsStep(ctx, zstdWindow)
		}
		if err != nil {
			if ctx.Err() == nil {
				d.log.Warn("tool output compression step failed; tried again when idle", "component", "daemon", "compress", compress, "err", err)
			}
			break
		}
		rows += st.Rows
		bytes += st.Bytes
		if st.Done {
			done = true
			break
		}
		select {
		case <-ctx.Done():
		case <-time.After(zstdPause(time.Since(t))):
		}
	}
	if rows == 0 {
		return done
	}
	d.actions.add(zstdAction(compress, rows, bytes, done))
	d.log.Info("tool output compression", "component", "daemon", "compress", compress,
		"rows", rows, "bytes", bytes, "done", done, "took", time.Since(start).Round(time.Millisecond))
	if done {
		// The Storage panel's figures are a day old at most; the run that
		// finished the pass makes them stale at once. idleLoop measures
		// after compactDB returns, so the measurement's long read never
		// holds up the repacking VACUUM.
		d.storage.mu.Lock()
		d.storage.tried = time.Time{}
		d.storage.mu.Unlock()
		if !compress {
			_ = d.store.SetMeta(ctx, store.MetaPayloadZstdRepacked, "0")
		}
	}
	return done
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
// the first pass. It is vacuumOnce: the same free-disk rule, the same time
// limit, interrupted by anything that wants to write, and tried again a day
// later when it could not run.
func (d *Daemon) zstdRepack(ctx context.Context, cs *compactState) {
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
	}
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
	return s + "; continues the next time Caprock is idle"
}

// CompressionReport is the switch and where the job is, for GET /v1/storage.
type CompressionReport struct {
	On bool `json:"on"`
	// ThroughMs is the time of the newest event the job has passed: tool
	// rows up to it are compressed (on) or still to restore (off). 0 when
	// nothing is compressed.
	ThroughMs int64 `json:"through_ms,omitempty"`
	// Restoring is true while it is off and compressed rows are left.
	Restoring bool `json:"restoring,omitempty"`
}

func (d *Daemon) compressionReport(ctx context.Context) CompressionReport {
	r := CompressionReport{On: d.config().CompressToolOutputOn()}
	if d.store == nil {
		return r
	}
	cur, err := d.store.PayloadZstdCursor(ctx)
	if err != nil || cur == 0 {
		return r
	}
	_ = d.store.DB().QueryRowContext(ctx, `SELECT ts FROM events WHERE id <= ? ORDER BY id DESC LIMIT 1`, cur).Scan(&r.ThroughMs)
	r.Restoring = !r.On
	return r
}
