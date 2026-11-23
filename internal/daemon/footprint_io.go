package daemon

import (
	"context"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/diskio"
	"github.com/dspv/caprock/internal/procstat"
)

// The daemon's own disk I/O, for the footprint: one reading of its
// cumulative counters a minute (a single syscall, or one small /proc read),
// kept in memory for an hour and never written anywhere.
const (
	ioEvery = time.Minute
	// ioRingLen readings a minute apart span an hour.
	ioRingLen = 61
)

type ioSample struct {
	at            time.Time
	read, written uint64
	// src is internal/diskio's totals by source at the same moment.
	src map[string]diskio.Source
}

// bySourceTop is how many sources by_source lists; the rest are summed into
// one "other sources" row. Thirty, not ten: on the owner's daemon the rest
// read more than any one source listed (3.4 GB an hour over 240,000
// statements, 2026-11-23), and could not be told apart.
const bySourceTop = 30

// ioRing is the last hour of readings, oldest first.
type ioRing struct {
	mu    sync.Mutex
	buf   []ioSample
	err   string
	start time.Time
}

func newIORing(start time.Time) *ioRing { return &ioRing{start: start} }

func (r *ioRing) add(s ioSample) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.err = ""
	r.buf = append(r.buf, s)
	if n := len(r.buf); n > ioRingLen {
		r.buf = append(r.buf[:0], r.buf[n-ioRingLen:]...)
	}
}

func (r *ioRing) fail(err error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.err = err.Error()
}

// IOWindow is the bytes read and written over Seconds.
type IOWindow struct {
	ReadBytes  uint64 `json:"read_bytes"`
	WriteBytes uint64 `json:"write_bytes"`
	Seconds    int64  `json:"seconds"`
}

// FootprintDiskIO is the daemon's own reads and writes.
type FootprintDiskIO struct {
	IntervalS int `json:"interval_s"`
	Samples   int `json:"samples"`
	// LastMinute is between the two newest readings; LastHour between the
	// oldest kept and the newest (shorter while the daemon is younger than
	// an hour, and Seconds says how long). Both are absent until there are
	// two readings.
	LastMinute *IOWindow `json:"last_minute,omitempty"`
	LastHour   *IOWindow `json:"last_hour,omitempty"`
	// SinceStart is the counters at the newest reading: everything the
	// daemon has read and written since it started.
	SinceStart *IOWindow `json:"since_start,omitempty"`
	// BySource is LastHour's reads split by what was running when they
	// were made (internal/diskio), largest first: the top thirty
	// (bySourceTop), the rest in one "other sources" row. Absent with LastHour.
	BySource []diskio.Source `json:"by_source,omitempty"`
	Error    string          `json:"error,omitempty"`
}

func delta(a, b ioSample) *IOWindow {
	sub := func(x, y uint64) uint64 {
		if y < x {
			return 0
		}
		return y - x
	}
	return &IOWindow{ReadBytes: sub(a.read, b.read), WriteBytes: sub(a.written, b.written), Seconds: int64(b.at.Sub(a.at).Round(time.Second) / time.Second)}
}

// topSources is the first bySourceTop of a sorted list and one row for the
// rest.
func topSources(all []diskio.Source) []diskio.Source {
	if len(all) <= bySourceTop {
		return all
	}
	rest := diskio.Source{Name: "other sources"}
	for _, s := range all[bySourceTop:] {
		rest.ReadBytes += s.ReadBytes
		rest.LogicalBytes += s.LogicalBytes
		rest.Ops += s.Ops
	}
	return append(all[:bySourceTop:bySourceTop], rest)
}

func (r *ioRing) report() *FootprintDiskIO {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := &FootprintDiskIO{IntervalS: int(ioEvery / time.Second), Samples: len(r.buf), Error: r.err}
	n := len(r.buf)
	if n == 0 {
		return out
	}
	newest := r.buf[n-1]
	out.SinceStart = &IOWindow{ReadBytes: newest.read, WriteBytes: newest.written, Seconds: int64(newest.at.Sub(r.start).Round(time.Second) / time.Second)}
	if n >= 2 {
		out.LastMinute = delta(r.buf[n-2], newest)
		out.LastHour = delta(r.buf[0], newest)
		out.BySource = topSources(diskio.Delta(r.buf[0].src, newest.src))
	}
	return out
}

// ioLoop reads the daemon's I/O counters now and every minute after, and
// checkpoints an oversized write-ahead log on the same tick (actions.go).
func (d *Daemon) ioLoop(ctx context.Context) {
	var lastCheckpoint time.Time
	read := func() {
		rd, wr, err := procstat.SelfDiskIO()
		if err != nil {
			d.io.fail(err)
			return
		}
		d.io.add(ioSample{at: time.Now(), read: rd, written: wr, src: diskio.Snapshot()})
	}
	read()
	t := time.NewTicker(ioEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			read()
			d.checkpointWAL(ctx, &lastCheckpoint)
		}
	}
}
