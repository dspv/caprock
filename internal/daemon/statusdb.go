package daemon

import (
	"context"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/store"
)

// The figures /v1/status reads from the database are kept in a snapshot that
// a background refresh renews; the request only copies it.
//
// Why: the desktop app asks /healthz and /v1/status with a 0.8 s timeout, and
// on the owner's 2 GB database the status call missed it several times a day
// (app.log, 2026-10-29 to 2026-11-18: "/v1/status: WouldBlock"). 45 of 48
// misses lined up in the daemon's log with HandoffCoverage and HandoffEffect,
// the handoff figures, run inside the request once a minute when their cache
// expired while every other status caller queued on the same mutex; 447 of
// 1,091 of them logged as slow took 0.8 s or more. The other 3 were
// single-row reads of meta (the interrupted sessions, the skipped upgrade
// copy) waiting 0.8-2.7 s for one of the pool's eight connections while the
// dashboard's aggregates held them all.
// A status answer that is a few seconds old is indistinguishable from a fresh
// one on every screen that shows it; one that does not come is read as a
// daemon in trouble.
const (
	// statusDBTTL is how old the single-row figures may be before a request
	// starts a refresh. A session continued from the interrupted list leaves
	// it within this.
	statusDBTTL = 5 * time.Second
	// eventCountTTL is how long the stored-event count is reused. COUNT(*)
	// walks an index of every row: 600 ms on a cold connection over 333k rows
	// (2026-10-04), 9.7 s on the owner's 1M rows under load (2026-11-15).
	eventCountTTL = 30 * time.Second
	// statusSlowTTL is how long the handoff figures are reused: 0.26 s to
	// count 330k events and 0.64 s to find a fortnight's passages, cold,
	// measured 2026-10-04 on a copy; slow to move, polled every 30 s.
	statusSlowTTL = time.Minute
	// statusFirstWait bounds how long the first status after a start waits
	// for the first refresh, well inside the app's 0.8 s; past it the answer
	// goes out without the figures and the next one has them.
	statusFirstWait = 250 * time.Millisecond
	// statusRefreshWithin bounds one refresh. It runs off the request, so
	// it may take what a busy database needs. The handoff figures used to
	// be cut off at 2 s, which 105 of 1,091 slow runs reached, and the
	// status then showed no memory figures for that minute.
	statusRefreshWithin = 30 * time.Second
)

// dbStatus is the database's part of /v1/status.
type dbStatus struct {
	// at is when the single-row figures were read.
	at          time.Time
	interrupted *Interrupted
	copySkipped *store.CopySkip
	move        *MoveStatus

	events   int64
	eventsAt time.Time
	eventsOK bool

	mem   MemoryStatus
	memAt time.Time
}

// statusCache holds the last dbStatus and whether a refresh is running.
type statusCache struct {
	mu sync.Mutex
	v  dbStatus
	ok bool // the first stage of a refresh has finished at least once
	// running is set while a refresh goroutine is out; first is closed when
	// that refresh has published its single-row figures.
	running bool
	first   chan struct{}
	// now is the clock the TTLs are measured on; nil means time.Now. Tests
	// set it, since two reads of the wall clock a few milliseconds apart
	// can be equal on Windows.
	now func() time.Time
}

func (c *statusCache) clock() time.Time {
	if c.now != nil {
		return c.now()
	}
	return time.Now()
}

// forget drops the snapshot, so the next read waits for a fresh one (up to
// statusFirstWait). For tests that change a figure and read it straight back.
func (c *statusCache) forget() {
	c.mu.Lock()
	c.v, c.ok = dbStatus{}, false
	c.mu.Unlock()
}

// dbStatus answers the database's figures from the snapshot, never from the
// database. A stale snapshot starts one background refresh and is answered
// as it is; only a daemon with no snapshot yet waits, and at most
// statusFirstWait.
func (d *Daemon) dbStatus() dbStatus {
	c := &d.statusDB
	c.mu.Lock()
	if !c.running && (!c.ok || c.clock().Sub(c.v.at) >= statusDBTTL) {
		c.running = true
		c.first = make(chan struct{})
		go d.refreshDBStatus(c.v, c.first)
	}
	v, ok, first := c.v, c.ok, c.first
	c.mu.Unlock()
	if ok {
		return v
	}
	t := time.NewTimer(statusFirstWait)
	defer t.Stop()
	select {
	case <-first:
	case <-t.C:
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.v
}

// refreshDBStatus reads the figures and publishes them in two steps: the
// single-row reads and the event count first, which is what a first status
// waits for, then the handoff figures when theirs are due. A figure that
// fails to read keeps its last value.
func (d *Daemon) refreshDBStatus(prev dbStatus, first chan struct{}) {
	c := &d.statusDB
	firstDone := false
	defer func() {
		c.mu.Lock()
		c.running = false
		c.mu.Unlock()
		if !firstDone {
			close(first)
		}
	}()
	base := d.baseCtx
	if base == nil {
		base = context.Background()
	}
	ctx, cancel := context.WithTimeout(base, statusRefreshWithin)
	defer cancel()
	v := prev
	if d.store != nil {
		v.interrupted = d.interrupted(ctx)
		if cs, err := d.store.CopySkipped(ctx); err == nil {
			v.copySkipped = cs
		}
		if moved, total, err := d.store.MoveProgress(ctx); err == nil {
			v.move = nil
			if total > 0 {
				v.move = &MoveStatus{Moved: moved, Total: total}
			}
		}
		if !v.eventsOK || c.clock().Sub(v.eventsAt) >= eventCountTTL {
			if n, err := d.eventCount.Count(ctx, d.store.DB()); err == nil {
				v.events, v.eventsAt, v.eventsOK = n, c.clock(), true
			}
		}
	}
	v.at = c.clock()
	publish := func() {
		c.mu.Lock()
		// A forget while this ran: keep what was read, it is fresher than
		// nothing.
		c.v, c.ok = v, true
		c.mu.Unlock()
	}
	publish()
	close(first)
	firstDone = true
	if !v.memAt.IsZero() && c.clock().Sub(v.memAt) < statusSlowTTL {
		return
	}
	if ms, err := d.memoryStatus(ctx); err == nil {
		v.mem, v.memAt = ms, c.clock()
		publish()
	}
}
