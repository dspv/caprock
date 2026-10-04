package ingest

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"

	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/cost"
	"github.com/dspv/caprock/internal/rollup"
	"github.com/dspv/caprock/internal/store"
)

// A line whose write fails because the database is busy is read again, not
// skipped.
//
// The tailer used to log the failure and move its offset past the line, so the
// turn was never read again: 259 assistant turns ($18.52) went missing that way
// on the owner's machine in a day and a half, with a warning in the log as the
// only trace. A busy database is a reason to try later, never a reason to drop.
func TestABusyDatabaseDoesNotLoseTheLine(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "c.db")
	st, err := store.Open(ctx, dbPath, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	// One connection with a short wait, so the held lock below makes the
	// recorder fail in milliseconds rather than after the daemon's five
	// seconds. The failure is the same SQLITE_BUSY either way.
	st.DB().SetMaxOpenConns(1)
	if _, err := st.DB().ExecContext(ctx, `PRAGMA busy_timeout = 20`); err != nil {
		t.Fatal(err)
	}
	tb, _ := cost.Embedded()
	root := filepath.Join(dir, "projects")
	path := filepath.Join(root, "-busy", "s.jsonl")
	writeTranscript(t, path, "dddddddd-eeee-ffff-0000-111111111111")
	tl := New(root, rollup.New(st, tb, bus.New(), nil), st, quiet())
	tl.BackfillWindow = 0
	if err := tl.discover(nil); err != nil {
		t.Fatal(err)
	}

	// Another process holds the write lock.
	holder, err := sql.Open("sqlite", "file:"+dbPath)
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
	tl.pass(ctx, false)
	if n := tl.Stats().EventsStored; n != 0 {
		t.Fatalf("stored %d events while the database was locked", n)
	}

	// The lock goes away; the file has not changed. The next pass must still
	// read the line — an ended session never writes another one to wake it.
	if _, err := conn.ExecContext(ctx, `ROLLBACK`); err != nil {
		t.Fatal(err)
	}
	tl.pass(ctx, false)
	if n := tl.Stats().EventsStored; n == 0 {
		t.Fatal("the line that hit a busy database was never stored: it was skipped, not retried")
	}
}
