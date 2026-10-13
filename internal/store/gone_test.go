package store

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// A session with no pid has nothing to ask but the clock — except the disk.
// On 2026-10-14 a test script wrote nine synthetic transcripts under
// ~/.claude/projects and removed them; the nine sessions read from them sat
// in the sidebar as "working" and would have stayed for 24 hours. A deleted
// transcript, or a deleted directory, ends such a session on the next sweep.
func TestANoPidSessionWhoseFilesAreGoneEndsOnTheNextSweep(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	dir := t.TempDir()
	recent := time.Now().Add(-time.Second)
	day := time.Now().Add(-24 * time.Hour).UnixMilli()

	write := func(name string) string {
		t.Helper()
		p := filepath.Join(dir, name+".jsonl")
		if err := os.WriteFile(p, []byte("{}\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		return p
	}
	upsert := func(id string, p SessionPatch) {
		t.Helper()
		p.StartedAt, p.LastEventAt = recent.UnixMilli(), recent.UnixMilli()
		if err := UpsertSession(ctx, s.DB(), id, p); err != nil {
			t.Fatal(err)
		}
	}

	// Read from a transcript that has since been deleted: ends now.
	deleted := write("deleted")
	upsert("transcript-gone", SessionPatch{Cwd: dir, TranscriptPath: deleted, FromTranscript: true})
	if err := os.Remove(deleted); err != nil {
		t.Fatal(err)
	}
	// Ran in a directory that has since been deleted: ends now.
	gone := filepath.Join(dir, "removed-worktree")
	if err := os.Mkdir(gone, 0o700); err != nil {
		t.Fatal(err)
	}
	upsert("cwd-gone", SessionPatch{Cwd: gone, TranscriptPath: write("cwd-gone"), FromTranscript: true})
	if err := os.Remove(gone); err != nil {
		t.Fatal(err)
	}
	// Transcript still there: the clock still decides, and a second is not a day.
	upsert("transcript-kept", SessionPatch{Cwd: dir, TranscriptPath: write("kept"), FromTranscript: true})
	// A hook may name a transcript Claude Code has not written yet: without
	// has_transcript the path proves nothing.
	upsert("hook-only", SessionPatch{Cwd: dir, TranscriptPath: filepath.Join(dir, "not-yet.jsonl"), FromHook: true})

	// A live pid decides on its own, files or no files.
	cmd := exec.Command(sleeper(), sleeperArgs()...)
	if err := cmd.Start(); err != nil {
		t.Skipf("cannot start a helper process: %v", err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	bootedAt(t, time.Now().Add(-time.Hour))
	upsert("live-pid", SessionPatch{
		Cwd: filepath.Join(dir, "nowhere"), TranscriptPath: filepath.Join(dir, "nowhere.jsonl"),
		FromTranscript: true, PID: cmd.Process.Pid,
	})

	ended, err := MarkEndedSessions(ctx, s.DB(), day)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, id := range ended {
		got[id] = true
	}
	for _, id := range []string{"transcript-gone", "cwd-gone"} {
		if !got[id] {
			t.Errorf("%s: still open, want ended on the first sweep", id)
		}
	}
	for _, id := range []string{"transcript-kept", "hook-only", "live-pid"} {
		if got[id] {
			t.Errorf("%s: ended, want it left alone", id)
		}
	}
	if len(ended) != 2 {
		t.Errorf("ended %v, want exactly the two whose files are gone", ended)
	}
}

// A relative or empty path, and a path that exists, are never "gone".
func TestMissingOnlyMeansDoesNotExist(t *testing.T) {
	dir := t.TempDir()
	cases := map[string]bool{
		"":                                false,
		"relative/path":                   false,
		dir:                               false,
		filepath.Join(dir, "no-such"):     true,
		filepath.Join(dir, "a", "b", "c"): true,
	}
	for p, want := range cases {
		if got := missing(p); got != want {
			t.Errorf("missing(%q) = %v, want %v", p, got, want)
		}
	}
}
