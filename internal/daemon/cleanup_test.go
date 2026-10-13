package daemon

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

type fakeLookup struct {
	sessions map[string]struct {
		ended bool
		last  time.Time
	}
	cwds map[string]bool
}

func (f fakeLookup) session(_ context.Context, id string) (bool, bool, int64) {
	s, ok := f.sessions[id]
	return ok, s.ended, s.last.UnixMilli()
}

func (f fakeLookup) cwdUsed(_ context.Context, dir string) bool { return f.cwds[dir] }

// The sweep removes what the rules name and nothing else, judged by age
// against the clock it is given.
func TestSweepRemovesOnlyWhatTheRulesName(t *testing.T) {
	dir := t.TempDir()
	now := time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC)
	old, recent := now.Add(-31*24*time.Hour), now.Add(-29*24*time.Hour)
	write := func(p string, n int, at time.Time) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, make([]byte, n), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(p, at, at); err != nil {
			t.Fatal(err)
		}
	}
	mkdir := func(p string, at time.Time) {
		t.Helper()
		if err := os.MkdirAll(p, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(p, at, at); err != nil {
			t.Fatal(err)
		}
	}
	paste := filepath.Join(dir, "paste")
	write(filepath.Join(paste, "20260901-101010-aa", "shot.png"), 100, old) // gone
	write(filepath.Join(paste, "drop-1700000000", "doc.pdf"), 200, old)     // gone: the app's drops too
	write(filepath.Join(paste, "20260903-135850-b0f06691.png"), 300, old)   // gone: an older flat file
	write(filepath.Join(paste, "20260915-101010-bb", "shot.png"), 400, recent)
	// A paste directory with an old file and a fresh one is kept.
	write(filepath.Join(paste, "20260901-111111-cc", "a.txt"), 10, old)
	write(filepath.Join(paste, "20260901-111111-cc", "b.txt"), 10, recent)
	// A directory's own time is when its file was written into it.
	for name, at := range map[string]time.Time{"20260901-101010-aa": old, "drop-1700000000": old, "20260915-101010-bb": recent, "20260901-111111-cc": recent} {
		if err := os.Chtimes(filepath.Join(paste, name), at, at); err != nil {
			t.Fatal(err)
		}
	}

	chats := filepath.Join(dir, "chats")
	mkdir(filepath.Join(chats, "2026-10-01-100000"), now.Add(-48*time.Hour)) // empty, no session: gone
	mkdir(filepath.Join(chats, "2026-10-01-110000"), now.Add(-48*time.Hour)) // empty, a session ran there: kept
	mkdir(filepath.Join(chats, "2026-10-13-110000"), now.Add(-time.Hour))    // empty, too new: kept
	write(filepath.Join(chats, "2026-10-01-120000", "notes.md"), 5, old)     // not empty: kept

	gem := filepath.Join(dir, "gemini")
	write(filepath.Join(gem, "g-old.otel.log"), 1000, old)     // ended 31 days ago: gone
	write(filepath.Join(gem, "g-recent.otel.log"), 1000, old)  // ended 29 days ago: kept
	write(filepath.Join(gem, "g-live.otel.log"), 1000, old)    // still running: kept
	write(filepath.Join(gem, "g-unknown.otel.log"), 1000, old) // never recorded: kept

	write(filepath.Join(dir, "launchd.log"), 50, old) // nothing writes it: gone
	write(filepath.Join(dir, "caprock.db"), 5000, old)
	write(filepath.Join(dir, "caprock.log"), 70, old)

	look := fakeLookup{
		sessions: map[string]struct {
			ended bool
			last  time.Time
		}{
			"g-old":    {true, old},
			"g-recent": {true, recent},
			"g-live":   {false, old},
		},
		cwds: map[string]bool{filepath.Join(chats, "2026-10-01-110000"): true},
	}
	r := sweepDataDir(context.Background(), dir, now, look)
	if r.Paste != 3 || r.Chats != 1 || r.Gemini != 1 || r.Logs != 1 {
		t.Fatalf("removed %+v", r)
	}
	if r.Bytes != 100+200+300+1000+50 {
		t.Fatalf("freed %d bytes", r.Bytes)
	}
	gone := []string{
		"paste/20260901-101010-aa", "paste/drop-1700000000", "paste/20260903-135850-b0f06691.png",
		"chats/2026-10-01-100000", "gemini/g-old.otel.log", "launchd.log",
	}
	kept := []string{
		"paste/20260915-101010-bb/shot.png", "paste/20260901-111111-cc/a.txt",
		"chats/2026-10-01-110000", "chats/2026-10-13-110000", "chats/2026-10-01-120000/notes.md",
		"gemini/g-recent.otel.log", "gemini/g-live.otel.log", "gemini/g-unknown.otel.log",
		"caprock.db", "caprock.log",
	}
	for _, p := range gone {
		if _, err := os.Stat(filepath.Join(dir, p)); !os.IsNotExist(err) {
			t.Errorf("%s was not removed", p)
		}
	}
	for _, p := range kept {
		if _, err := os.Stat(filepath.Join(dir, p)); err != nil {
			t.Errorf("%s was removed: %v", p, err)
		}
	}
	// A second sweep finds nothing more to do.
	if r := sweepDataDir(context.Background(), dir, now, look); r.removed() != 0 {
		t.Fatalf("second sweep removed %+v", r)
	}
}

// Housekeeping waits for a quiet spell, and then runs at most once per its
// period.
func TestIdleDueWaitsForQuietAndForThePeriod(t *testing.T) {
	now := time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC)
	busy, quiet := now.Add(-5*time.Minute), now.Add(-idleFor)
	cases := []struct {
		name     string
		last     time.Time
		activity time.Time
		want     bool
	}{
		{"never run, busy", time.Time{}, busy, false},
		{"never run, quiet", time.Time{}, quiet, true},
		{"ran an hour ago, quiet", now.Add(-time.Hour), quiet, false},
		{"ran a day ago, quiet", now.Add(-24 * time.Hour), quiet, true},
		{"ran a day ago, busy", now.Add(-24 * time.Hour), busy, false},
	}
	for _, c := range cases {
		if got := idleDue(c.last, c.activity, now, 24*time.Hour); got != c.want {
			t.Errorf("%s: idleDue = %v, want %v", c.name, got, c.want)
		}
	}
}

// GET /v1/storage measures only when the cache is a day old, never twice at
// once, and says so while it runs.
func TestStorageIsMeasuredOnlyWhenStale(t *testing.T) {
	now := time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC)
	if !storageDue(time.Time{}, now) || !storageDue(now.Add(-storageMaxAge), now) || storageDue(now.Add(-time.Hour), now) {
		t.Fatal("storageDue disagrees with storageMaxAge")
	}
	d := &Daemon{}
	d.storage.tried = now.Add(-time.Hour)
	if d.startMeasure(now) {
		t.Fatal("measured although the last measurement is an hour old")
	}
	d.storage.running = true
	d.storage.tried = time.Time{}
	if !d.startMeasure(now) {
		t.Fatal("a running measurement is not reported")
	}
	if !d.storage.tried.IsZero() {
		t.Fatal("a second measurement was started beside the running one")
	}
}
