package daemon

import (
	"context"
	"database/sql"
	"encoding/json"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/store"
)

// settled waits for the status refresh in flight, if any, to finish.
func settled(t *testing.T, d *Daemon) dbStatus {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		d.statusDB.mu.Lock()
		v, ok, running := d.statusDB.v, d.statusDB.ok, d.statusDB.running
		d.statusDB.mu.Unlock()
		if ok && !running {
			return v
		}
		if time.Now().After(deadline) {
			t.Fatal("the status refresh never finished")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// age makes the snapshot older than every TTL.
func age(d *Daemon) {
	d.statusDB.mu.Lock()
	old := time.Now().Add(-statusSlowTTL - time.Second)
	d.statusDB.v.at, d.statusDB.v.eventsAt, d.statusDB.v.memAt = old, old, old
	d.statusDB.mu.Unlock()
}

// holdPool takes every connection the store's pool will give, so any query
// waits until release. It is what the dashboard's aggregates did to the
// owner's daemon: slow reads holding the connections, and /v1/status queued
// behind them for one.
func holdPool(t *testing.T, st *store.Store) (release func()) {
	t.Helper()
	db := st.DB()
	var conns []*sql.Conn
	for range db.Stats().MaxOpenConnections {
		c, err := db.Conn(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		conns = append(conns, c)
	}
	return func() {
		for _, c := range conns {
			_ = c.Close()
		}
	}
}

// The handoff figures are reused for statusSlowTTL, the event count for
// eventCountTTL, and the single-row figures for statusDBTTL.
func TestStatusFiguresAreReusedForTheirTTL(t *testing.T) {
	d := &Daemon{log: quietLog(), store: memStore(t)}
	d.dbStatus()
	first := settled(t, d)
	if !first.eventsOK || first.memAt.IsZero() {
		t.Fatalf("first refresh = %+v, want the count and the memory figures", first)
	}
	d.dbStatus()
	if got := settled(t, d); !got.at.Equal(first.at) || !got.memAt.Equal(first.memAt) {
		t.Fatalf("read again within the TTL: %+v, want the reused %+v", got, first)
	}
	// Past the short TTL only: the single-row figures again, not the rest.
	d.statusDB.mu.Lock()
	d.statusDB.v.at = time.Now().Add(-statusDBTTL - time.Second)
	d.statusDB.mu.Unlock()
	d.dbStatus()
	got := settled(t, d)
	if !got.at.After(first.at) || !got.memAt.Equal(first.memAt) || !got.eventsAt.Equal(first.eventsAt) {
		t.Fatalf("after %v: %+v; want only the single-row figures read again", statusDBTTL, got)
	}
	age(d)
	d.dbStatus()
	if got := settled(t, d); !got.memAt.After(first.memAt) || !got.eventsAt.After(first.eventsAt) {
		t.Fatalf("not read again after every TTL: %+v", got)
	}
}

// /v1/status answers from its snapshot while every database connection is
// busy, and has the new figures once the database is free again. Before the
// snapshot this call waited for a connection, and the desktop app's 0.8 s
// check gave up on it several times a day on the owner's Mac.
func TestStatusAnswersWhileTheDatabaseIsBusy(t *testing.T) {
	ctx := context.Background()
	st := memStore(t)
	d := &Daemon{log: quietLog(), store: st, opt: Options{Config: config.Defaults()}}
	d.dbStatus()
	before := settled(t, d)
	if _, err := store.InsertEvent(ctx, st.DB(), &event.Event{SessionID: "s", Source: event.SourceHook,
		Kind: event.KindToolPre, Tool: "Read", Key: "k", Ts: time.Now(), Payload: json.RawMessage(`{}`)}); err != nil {
		t.Fatal(err)
	}
	age(d)
	release := holdPool(t, st)
	start := time.Now()
	got := d.dbStatus()
	took := time.Since(start)
	release()
	if took > 50*time.Millisecond {
		t.Fatalf("status took %v with the database busy; it must not wait on it", took)
	}
	if got.events != before.events {
		t.Fatalf("events = %d, want the snapshot's %d", got.events, before.events)
	}
	if after := settled(t, d); after.events != before.events+1 {
		t.Fatalf("events after the database freed = %d, want %d", after.events, before.events+1)
	}
}

// The first status after a start, with no snapshot yet and the database
// busy, waits statusFirstWait at most and answers without the figures.
func TestFirstStatusWaitsBriefly(t *testing.T) {
	st := memStore(t)
	d := &Daemon{log: quietLog(), store: st, opt: Options{Config: config.Defaults()}}
	release := holdPool(t, st)
	start := time.Now()
	got := d.dbStatus()
	took := time.Since(start)
	release()
	if took > statusFirstWait+200*time.Millisecond {
		t.Fatalf("first status took %v, want at most about %v", took, statusFirstWait)
	}
	if got.eventsOK {
		t.Fatalf("a count with every connection held: %+v", got)
	}
	if v := settled(t, d); !v.eventsOK {
		t.Fatalf("no count once the database freed: %+v", v)
	}
}
