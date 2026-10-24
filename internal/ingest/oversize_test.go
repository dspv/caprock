// A transcript record longer than MaxLine: skipped without being held in
// memory, counted once, and never the reason a line after it is lost.
//
// The tailer used to read a whole record before looking at its length, so a
// 32 MiB record cost 67 MB per read (2026-10-18 audit, F1); a complete one was
// never measured against MaxLine at all; and a partial one was dropped by
// moving the offset into its middle, which the next read took for a rewritten
// file and answered by reading the whole transcript again.
package ingest

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"

	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/cost"
	"github.com/dspv/caprock/internal/rollup"
	"github.com/dspv/caprock/internal/store"
)

// testMaxLine is above the reader's 256 KiB buffer, so a record near the limit
// arrives in more than one fragment.
const testMaxLine = 300 << 10

const oversizeSession = "abababab-cdcd-efef-0101-232323232323"

// turnLine is a valid assistant line whose text is padded so the line, before
// its newline, is exactly length bytes (0 means no padding).
func turnLine(i, length int) string {
	head := `{"type":"assistant","uuid":"o-` + strconv.Itoa(i) + `","sessionId":"` + oversizeSession +
		`","cwd":"/home/u/proj","timestamp":"2026-08-18T10:00:00.000Z","message":{"model":"claude-opus-5","id":"om-` +
		strconv.Itoa(i) + `","role":"assistant","content":[{"type":"text","text":"`
	tail := `"}],"usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}`
	pad := "turn " + strconv.Itoa(i)
	if length > 0 {
		pad = strings.Repeat("y", length-len(head)-len(tail))
	}
	return head + pad + tail
}

func oversizeTailer(t *testing.T) (tl *Tailer, path string) {
	t.Helper()
	root := t.TempDir()
	path = filepath.Join(root, "-oversize", "s.jsonl")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	tl, _ = newTailerAt(t, root)
	tl.MaxLine = testMaxLine
	if err := tl.discover(nil); err != nil {
		t.Fatal(err)
	}
	return tl, path
}

func appendTo(t *testing.T, path, s string) {
	t.Helper()
	fh, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer fh.Close()
	if _, err := fh.WriteString(s); err != nil {
		t.Fatal(err)
	}
}

func turnsStored(t *testing.T, st *store.Store) int {
	t.Helper()
	var n int
	if err := st.DB().QueryRow(`SELECT COUNT(*) FROM events JOIN sessions USING (sid) WHERE session_id = ? AND kind = 'turn.assistant'`,
		oversizeSession).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func state(tl *Tailer, path string) (offset, skipTo int64) {
	tl.mu.Lock()
	f := tl.files[path]
	tl.mu.Unlock()
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.offset, f.skipTo
}

func fileSize(t *testing.T, path string) int64 {
	t.Helper()
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return fi.Size()
}

// A record of exactly MaxLine bytes is read as before; one byte more is the
// first length skipped, even when it is valid JSON.
func TestARecordOfMaxLineIsKeptAndOneByteMoreIsSkipped(t *testing.T) {
	tl, path := oversizeTailer(t)
	appendTo(t, path, turnLine(1, testMaxLine)+"\n"+turnLine(2, testMaxLine+1)+"\n"+turnLine(3, 0)+"\n")
	tl.pass(context.Background(), false)
	if n := turnsStored(t, tl.Store); n != 2 {
		t.Fatalf("stored %d turns, want 2: the MaxLine record and the line after the skipped one", n)
	}
	if n := tl.Stats().LinesMalformed; n != 1 {
		t.Fatalf("malformed lines %d, want 1", n)
	}
	if off, skip := state(tl, path); off != fileSize(t, path) || skip != 0 {
		t.Fatalf("offset %d skipTo %d, want %d and 0", off, skip, fileSize(t, path))
	}
}

// A record still being written within MaxLine waits for its newline, across
// reader fragments, exactly as it did.
func TestAPartialRecordWithinTheLimitWaitsForItsNewline(t *testing.T) {
	tl, path := oversizeTailer(t)
	line := turnLine(1, testMaxLine-10)
	appendTo(t, path, line[:len(line)-100])
	tl.pass(context.Background(), false)
	if off, skip := state(tl, path); off != 0 || skip != 0 || turnsStored(t, tl.Store) != 0 {
		t.Fatalf("a partial record moved the offset to %d (skipTo %d)", off, skip)
	}
	appendTo(t, path, line[len(line)-100:]+"\n")
	tl.pass(context.Background(), false)
	if n := turnsStored(t, tl.Store); n != 1 {
		t.Fatalf("stored %d turns once the newline arrived, want 1", n)
	}
	if n := tl.Stats().LinesMalformed; n != 0 {
		t.Fatalf("malformed lines %d, want 0", n)
	}
}

// An oversized record written in pieces is counted once, the offset stays on a
// record boundary while it is skipped, and the line after its newline is read.
func TestAnOversizedRecordWrittenInPiecesIsSkippedOnce(t *testing.T) {
	tl, path := oversizeTailer(t)
	ctx := context.Background()
	first := turnLine(1, 0) + "\n"
	appendTo(t, path, first+strings.Repeat("x", testMaxLine+5))
	tl.pass(ctx, false)
	if n := turnsStored(t, tl.Store); n != 1 {
		t.Fatalf("stored %d turns, want the line before the record", n)
	}
	off, skip := state(tl, path)
	if off != int64(len(first)) || skip != fileSize(t, path) {
		t.Fatalf("offset %d skipTo %d, want %d and %d", off, skip, len(first), fileSize(t, path))
	}
	if got, err := store.GetOffset(ctx, tl.Store.DB(), path); err != nil || got != int64(len(first)) {
		t.Fatalf("persisted offset %d (%v), want the boundary %d", got, err, len(first))
	}

	// More of the record, still no newline: read from where it stopped, not
	// counted again.
	appendTo(t, path, strings.Repeat("x", 1<<20))
	tl.pass(ctx, false)
	if _, skip := state(tl, path); skip != fileSize(t, path) {
		t.Fatalf("skipTo %d, want %d", skip, fileSize(t, path))
	}

	// The delimiter arrives, with a valid line after it.
	appendTo(t, path, "x\n"+turnLine(2, 0)+"\n")
	tl.pass(ctx, false)
	if n := turnsStored(t, tl.Store); n != 2 {
		t.Fatalf("stored %d turns, want 2: the line after the newline was lost", n)
	}
	if n := tl.Stats().LinesMalformed; n != 1 {
		t.Fatalf("malformed lines %d, want the record counted once", n)
	}
	if off, skip := state(tl, path); off != fileSize(t, path) || skip != 0 {
		t.Fatalf("offset %d skipTo %d, want %d and 0", off, skip, fileSize(t, path))
	}
}

// After a restart the persisted boundary is where reading starts: the record
// is skipped again from its start and nothing after it is lost.
func TestARestartInsideAnOversizedRecordResumesAtItsStart(t *testing.T) {
	tl, path := oversizeTailer(t)
	ctx := context.Background()
	first := turnLine(1, 0) + "\n"
	appendTo(t, path, first+strings.Repeat("x", testMaxLine*2))
	tl.pass(ctx, false)

	tb, _ := cost.Embedded()
	again := New(tl.Root, rollup.New(tl.Store, tb, bus.New(), nil), tl.Store, quiet())
	again.BackfillWindow = 0
	again.MaxLine = testMaxLine
	if err := again.discover(nil); err != nil {
		t.Fatal(err)
	}
	appendTo(t, path, "\n"+turnLine(2, 0)+"\n")
	again.pass(ctx, false)
	if n := turnsStored(t, tl.Store); n != 2 {
		t.Fatalf("stored %d turns, want 2", n)
	}
	if n := again.Stats().LinesMalformed; n != 1 {
		t.Fatalf("malformed lines %d, want 1", n)
	}
}

// A transcript truncated while a record in it was being skipped is read from
// its start.
func TestATruncatedFileStopsTheSkip(t *testing.T) {
	tl, path := oversizeTailer(t)
	ctx := context.Background()
	appendTo(t, path, turnLine(1, 0)+"\n"+strings.Repeat("x", testMaxLine*2))
	tl.pass(ctx, false)
	if err := os.WriteFile(path, []byte(turnLine(2, 0)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	tl.pass(ctx, false)
	if n := turnsStored(t, tl.Store); n != 2 {
		t.Fatalf("stored %d turns, want the replacement's line too", n)
	}
	if off, skip := state(tl, path); off != fileSize(t, path) || skip != 0 {
		t.Fatalf("offset %d skipTo %d, want %d and 0", off, skip, fileSize(t, path))
	}
}

// A file whose first record is oversized and is then cut back below what was
// read of it: the record is looked at again from its start.
func TestAShrunkOversizedFirstRecordIsReadAgain(t *testing.T) {
	tl, path := oversizeTailer(t)
	ctx := context.Background()
	appendTo(t, path, strings.Repeat("x", testMaxLine*2))
	tl.pass(ctx, false)
	if _, skip := state(tl, path); skip == 0 {
		t.Fatal("the oversized record was not being skipped")
	}
	if err := os.WriteFile(path, []byte(turnLine(1, 0)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	tl.pass(ctx, false)
	if n := turnsStored(t, tl.Store); n != 1 {
		t.Fatalf("stored %d turns, want 1", n)
	}
}

// A cancelled read leaves the skip where it was; the next one finishes it.
func TestCancellationKeepsTheSkipState(t *testing.T) {
	tl, path := oversizeTailer(t)
	appendTo(t, path, turnLine(1, 0)+"\n"+strings.Repeat("x", testMaxLine*2))
	tl.pass(context.Background(), false)
	_, before := state(tl, path)
	appendTo(t, path, strings.Repeat("x", testMaxLine)+"\n"+turnLine(2, 0)+"\n")

	f := tl.files[path]
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	tl.readFile(cancelled, f, fi)
	if _, skip := state(tl, path); skip != before {
		t.Fatalf("a cancelled read moved skipTo from %d to %d", before, skip)
	}

	tl.pass(context.Background(), false)
	if n := turnsStored(t, tl.Store); n != 2 {
		t.Fatalf("stored %d turns, want 2", n)
	}
	if n := tl.Stats().LinesMalformed; n != 1 {
		t.Fatalf("malformed lines %d, want 1", n)
	}
}

// A busy database after an oversized record: the retry starts at the line that
// could not be written, not at the record already skipped.
func TestABusyDatabaseAfterAnOversizedRecordRetriesTheLine(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "c.db")
	st, err := store.Open(ctx, dbPath, quiet())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	st.DB().SetMaxOpenConns(1)
	if _, err := st.DB().ExecContext(ctx, `PRAGMA busy_timeout = 20`); err != nil {
		t.Fatal(err)
	}
	tb, _ := cost.Embedded()
	root := filepath.Join(dir, "projects")
	path := filepath.Join(root, "-busy", "s.jsonl")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	record := strings.Repeat("x", testMaxLine*2) + "\n"
	if err := os.WriteFile(path, []byte(record+turnLine(1, 0)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	tl := New(root, rollup.New(st, tb, bus.New(), nil), st, quiet())
	tl.BackfillWindow = 0
	tl.MaxLine = testMaxLine
	if err := tl.discover(nil); err != nil {
		t.Fatal(err)
	}

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
	if off, _ := state(tl, path); off != int64(len(record)) {
		t.Fatalf("offset %d, want the stalled line's start %d", off, len(record))
	}
	if _, err := conn.ExecContext(ctx, `ROLLBACK`); err != nil {
		t.Fatal(err)
	}
	tl.pass(ctx, false)
	if n := turnsStored(t, st); n != 1 {
		t.Fatalf("stored %d turns after the lock went, want 1", n)
	}
	if n := tl.Stats().LinesMalformed; n != 1 {
		t.Fatalf("malformed lines %d, want the record counted once", n)
	}
}

// The memory one read takes does not grow with the oversized record: about
// MaxLine plus a reader buffer, for a record four times the limit and for one
// sixteen times it. Reading the record whole cost twice its size.
func TestOversizedRecordAllocationIsBounded(t *testing.T) {
	for _, complete := range []bool{false, true} {
		var got []uint64
		for _, times := range []int{4, 16} {
			tl, path := oversizeTailer(t)
			data := strings.Repeat("x", testMaxLine*times)
			if complete {
				data += "\n"
			}
			appendTo(t, path, data)
			fi, err := os.Stat(path)
			if err != nil {
				t.Fatal(err)
			}
			f := tl.files[path]
			runtime.GC()
			var m0, m1 runtime.MemStats
			runtime.ReadMemStats(&m0)
			tl.readFile(context.Background(), f, fi)
			runtime.ReadMemStats(&m1)
			got = append(got, m1.TotalAlloc-m0.TotalAlloc)
		}
		// MaxLine copied in fragments, the reader's buffer, and slack for the
		// store write. Reading the record whole allocated about twice its size.
		const bound = 2*testMaxLine + 512<<10
		for i, a := range got {
			if a > bound {
				t.Errorf("complete=%v: read %d allocated %d bytes, want at most %d", complete, i, a, bound)
			}
		}
		t.Logf("complete=%v: allocated %d bytes (4x MaxLine) and %d bytes (16x MaxLine)", complete, got[0], got[1])
	}
}
