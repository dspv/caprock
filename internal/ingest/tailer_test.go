// The tailer's own behaviour: finding transcripts, running until told to stop,
// and backfilling old ones without blocking the live pass.
//
// This is the half of ingest that touches the filesystem, and the conditions it
// has to survive are ordinary rather than exotic — a directory that appears
// after startup, a file being written while it is read, a truncated or deleted
// transcript, a subtree it cannot open. None of those may stop the tailer: the
// dashboard goes quiet for every session if this loop exits.
package ingest

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/cost"
	"github.com/dspv/caprock/internal/rollup"
	"github.com/dspv/caprock/internal/store"
)

func quiet() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

// newTailerAt builds a tailer over an arbitrary root (newTailer's root is a
// fixture copy; some tests need an empty or hand-built tree).
func newTailerAt(t *testing.T, root string) (*Tailer, *store.Store) {
	t.Helper()
	st, err := store.Open(context.Background(), ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	tb, _ := cost.Embedded()
	tl := New(root, rollup.New(st, tb, bus.New(), nil), st, quiet())
	tl.BackfillWindow = 0
	return tl, st
}

// writeTranscript drops a minimal but valid transcript at the given path.
func writeTranscript(t *testing.T, path, sessionID string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	line := `{"type":"assistant","uuid":"u-1","sessionId":"` + sessionID +
		`","cwd":"/home/u/proj","timestamp":"2026-08-18T10:00:00.000Z","message":{"model":"claude-opus-5","id":"m-1","role":"assistant","content":[{"type":"text","text":"hello from a transcript"}],"usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}` + "\n"
	if err := os.WriteFile(path, []byte(line), 0o600); err != nil {
		t.Fatal(err)
	}
}

// DefaultRoot is what the daemon uses when no root is configured; pointing it
// at the wrong place means Caprock silently records nothing.
func TestDefaultRootIsUnderTheClaudeDir(t *testing.T) {
	got, err := DefaultRoot()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(filepath.ToSlash(got), ".claude/projects") {
		t.Errorf("DefaultRoot = %q; want it to end in .claude/projects", got)
	}
	if !filepath.IsAbs(got) {
		t.Errorf("DefaultRoot = %q; want an absolute path", got)
	}
}

// discover finds transcripts anywhere under the root, at any depth — Claude
// Code nests them one directory per project, and subagent sidechains deeper.
func TestDiscoverFindsNestedTranscripts(t *testing.T) {
	root := t.TempDir()
	writeTranscript(t, filepath.Join(root, "-proj-a", "s1.jsonl"), "11111111-2222-3333-4444-555555555555")
	writeTranscript(t, filepath.Join(root, "-proj-b", "nested", "s2.jsonl"), "22222222-3333-4444-5555-666666666666")
	// Not a transcript: must be ignored rather than parsed as one.
	if err := os.WriteFile(filepath.Join(root, "-proj-a", "notes.txt"), []byte("hi"), 0o600); err != nil {
		t.Fatal(err)
	}

	tl, _ := newTailerAt(t, root)
	if err := tl.discover(nil); err != nil {
		t.Fatal(err)
	}
	if n := tl.Stats().FilesKnown; n != 2 {
		t.Errorf("FilesKnown = %d; want the 2 .jsonl files and not the .txt", n)
	}
}

// A project directory created after startup is the normal case — every new
// repo the user opens. discover runs again on a timer, and must pick it up.
func TestDiscoverPicksUpADirectoryCreatedLater(t *testing.T) {
	root := t.TempDir()
	tl, _ := newTailerAt(t, root)
	if err := tl.discover(nil); err != nil {
		t.Fatal(err)
	}
	if n := tl.Stats().FilesKnown; n != 0 {
		t.Fatalf("FilesKnown = %d on an empty root", n)
	}

	writeTranscript(t, filepath.Join(root, "-new-proj", "s.jsonl"), "33333333-4444-5555-6666-777777777777")
	if err := tl.discover(nil); err != nil {
		t.Fatal(err)
	}
	if n := tl.Stats().FilesKnown; n != 1 {
		t.Errorf("FilesKnown = %d after a new project appeared; want 1", n)
	}
}

// An unreadable subtree must not abort the scan: one bad directory would
// otherwise stop every other project from being recorded.
func TestDiscoverSurvivesAnUnreadableDirectory(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX directory permissions")
	}
	if os.Geteuid() == 0 {
		t.Skip("root ignores directory permissions")
	}
	root := t.TempDir()
	writeTranscript(t, filepath.Join(root, "-good", "s.jsonl"), "44444444-5555-6666-7777-888888888888")
	bad := filepath.Join(root, "-locked")
	if err := os.MkdirAll(bad, 0o700); err != nil {
		t.Fatal(err)
	}
	writeTranscript(t, filepath.Join(bad, "hidden.jsonl"), "55555555-6666-7777-8888-999999999999")
	if err := os.Chmod(bad, 0o000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(bad, 0o700) })

	tl, _ := newTailerAt(t, root)
	if err := tl.discover(nil); err != nil {
		t.Fatalf("discover failed on an unreadable subtree: %v", err)
	}
	if n := tl.Stats().FilesKnown; n < 1 {
		t.Errorf("FilesKnown = %d; the readable project must still be found", n)
	}
}

// Run is the daemon's ingest loop. It must return on cancellation rather than
// leaving a ticker and a watcher alive after shutdown.
func TestRunStopsOnCancel(t *testing.T) {
	root := t.TempDir()
	writeTranscript(t, filepath.Join(root, "-proj", "s.jsonl"), "66666666-7777-8888-9999-aaaaaaaaaaaa")
	tl, _ := newTailerAt(t, root)
	tl.PollInterval = 20 * time.Millisecond

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- tl.Run(ctx) }()

	// Give it a moment to do its first pass, then stop it.
	waitFor(t, 3*time.Second, func() bool { return tl.Stats().EventsStored > 0 })
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Errorf("Run = %v on cancel; want nil", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not return on cancel; the daemon would hang at shutdown")
	}
}

// Run creates its root if it is missing — a machine where Claude Code has never
// written a transcript still has to start cleanly.
func TestRunCreatesAMissingRoot(t *testing.T) {
	root := filepath.Join(t.TempDir(), "not", "there", "yet")
	tl, _ := newTailerAt(t, root)
	tl.PollInterval = 20 * time.Millisecond

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- tl.Run(ctx) }()
	waitFor(t, 3*time.Second, func() bool {
		_, err := os.Stat(root)
		return err == nil
	})
	cancel()
	<-done

	if _, err := os.Stat(root); err != nil {
		t.Errorf("the root was not created: %v", err)
	}
}

// A transcript appearing in a directory Run already knows about must be picked
// up without waiting for the 30-second rescan — this is the common case of a
// session starting in a project the user has worked in before.
//
// Deliberately not tested here: a brand-new project *directory*. That one has
// two paths to discovery — an fsnotify Create on the root, or the 30s rescan —
// and which wins is a race, so a test would be timing-dependent by
// construction. TestDiscoverPicksUpADirectoryCreatedLater covers the rescan
// half directly, without a clock.
func TestRunPicksUpAFileWrittenWhileRunning(t *testing.T) {
	root := t.TempDir()
	projDir := filepath.Join(root, "-known")
	// The directory exists before Run starts, so it is watched from the outset.
	if err := os.MkdirAll(projDir, 0o700); err != nil {
		t.Fatal(err)
	}
	tl, st := newTailerAt(t, root)
	tl.PollInterval = 20 * time.Millisecond

	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go func() { _ = tl.Run(ctx) }()

	sessionID := "77777777-8888-9999-aaaa-bbbbbbbbbbbb"
	// Wait for Run to have completed its first pass before writing, otherwise
	// the file can land before the directory is watched and only the 30-second
	// rescan would find it. (`FilesKnown >= 0` was the earlier version of this
	// line and is trivially true — it waited for nothing.)
	waitFor(t, 5*time.Second, func() bool { return tl.Stats().BackfillDone })
	writeTranscript(t, filepath.Join(projDir, "s.jsonl"), sessionID)

	// Poll the tailer's own counter rather than the database. Querying
	// :memory: SQLite every 10ms starves the single writer — measured: the
	// ingest never completes and the wait times out, which looks exactly like
	// a product bug and is not one.
	waitFor(t, 20*time.Second, func() bool { return tl.Stats().EventsStored > 0 })

	stats, err := store.GetStats(ctx, st.DB(), sessionID)
	if err != nil || stats.Turns == 0 {
		t.Fatalf("a transcript written into a watched directory was never ingested (turns=%d, err=%v)", stats.Turns, err)
	}
}

// backfill handles the transcripts that predate this daemon. It must mark
// itself done even when there is nothing to do, because /v1/status reports it.
func TestBackfillCompletesOnAnEmptyRoot(t *testing.T) {
	tl, _ := newTailerAt(t, t.TempDir())
	tl.BackfillWindow = time.Hour
	tl.backfill(context.Background())
	if !tl.Stats().BackfillDone {
		t.Error("BackfillDone stayed false with nothing to backfill")
	}
}

// An old transcript is exactly what backfill exists for: the live pass skips
// it, so without this the history of every past session is invisible.
func TestBackfillReadsAnOldTranscript(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "-old", "s.jsonl")
	sessionID := "88888888-9999-aaaa-bbbb-cccccccccccc"
	writeTranscript(t, path, sessionID)
	old := time.Now().Add(-48 * time.Hour)
	if err := os.Chtimes(path, old, old); err != nil {
		t.Fatal(err)
	}

	tl, st := newTailerAt(t, root)
	tl.BackfillWindow = time.Hour // anything older than an hour is backfill
	if err := tl.discover(nil); err != nil {
		t.Fatal(err)
	}
	tl.backfill(context.Background())

	if !tl.Stats().BackfillDone {
		t.Error("BackfillDone is false after backfill returned")
	}
	stats, err := store.GetStats(context.Background(), st.DB(), sessionID)
	if err != nil {
		t.Fatal(err)
	}
	if stats.Turns == 0 {
		t.Error("the old transcript was never read; past sessions would be invisible")
	}
}

// Cancelling mid-backfill must stop it: the daemon is shutting down and this
// walks every historical transcript on the machine.
//
// This asserts that it returns, and nothing more, because nothing more is
// distinguishable from here. Two things were tried and rejected. Timing is
// noise: measured over 20 small files the guarded loop takes ~61µs and the
// unguarded one ~3ms, a gap that disappears under CI load. And "stored no
// events" holds even with every ctx check in this package deleted — the store
// itself refuses a query on a cancelled context, so the assertion would pass
// against a backfill that ignores cancellation entirely.
//
// What remains worth pinning is that it terminates rather than walking the
// whole history at shutdown; the per-file bail-out is visible in readFile's
// own loop condition.
func TestBackfillReturnsOnCancel(t *testing.T) {
	root := t.TempDir()
	old := time.Now().Add(-48 * time.Hour)
	for i := 0; i < 20; i++ {
		p := filepath.Join(root, "-p", "s"+string(rune('a'+i))+".jsonl")
		writeTranscript(t, p, "99999999-aaaa-bbbb-cccc-dddddddddddd")
		if err := os.Chtimes(p, old, old); err != nil {
			t.Fatal(err)
		}
	}
	tl, _ := newTailerAt(t, root)
	tl.BackfillWindow = time.Hour
	if err := tl.discover(nil); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // already cancelled
	done := make(chan struct{})
	go func() { defer close(done); tl.backfill(ctx) }()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("backfill did not return on a cancelled context")
	}
}

// A transcript that is deleted between discovery and reading must not stop the
// pass — Claude Code cleans old sessions up, and a rescan can race it.
func TestPassSurvivesADeletedFile(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "-gone", "s.jsonl")
	writeTranscript(t, path, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")

	tl, _ := newTailerAt(t, root)
	if err := tl.discover(nil); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	// Must not panic and must not hang.
	tl.pass(context.Background(), false)
}

// A transcript that shrinks means the file was replaced or truncated. Reading
// from the old offset would splice two different sessions together, so the
// tailer has to start over rather than resume.
func TestTruncatedFileIsReReadFromTheStart(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "-trunc", "s.jsonl")
	sessionID := "bbbbbbbb-cccc-dddd-eeee-ffffffffffff"
	writeTranscript(t, path, sessionID)

	tl, _ := newTailerAt(t, root)
	ctx := context.Background()
	if err := tl.discover(nil); err != nil {
		t.Fatal(err)
	}
	tl.pass(ctx, false)
	first := tl.Stats().EventsStored
	if first == 0 {
		t.Fatal("nothing was stored on the first pass")
	}

	// Replace with a genuinely shorter file. Swapping the session id alone is
	// not enough — every UUID is the same length, so the file size would not
	// change and the truncation branch would never run.
	before, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	short := `{"type":"user","uuid":"u-2","sessionId":"cccccccc-dddd-eeee-ffff-000000000000","cwd":"/p","timestamp":"2026-08-18T11:00:00.000Z","message":{"role":"user","content":"hi"}}` + "\n"
	if err := os.WriteFile(path, []byte(short), 0o600); err != nil {
		t.Fatal(err)
	}
	after, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if after.Size() >= before.Size() {
		t.Fatalf("the replacement is %d bytes against %d; it has to be shorter to truncate", after.Size(), before.Size())
	}
	tl.pass(ctx, false)

	if tl.Stats().EventsStored <= first {
		t.Error("a truncated file was not re-read; its new contents would be lost")
	}
}

// waitFor polls until cond holds or the deadline passes, so tests do not depend
// on a fixed sleep being long enough on a loaded CI runner.
func waitFor(t *testing.T, d time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
}
