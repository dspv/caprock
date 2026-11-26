// Follow: the transcript a hook names is read even when the walk of the
// root never finds it (issue #1085). A Windows PC's daemon started a Claude
// Code session itself, its hooks arrived, and the session showed no turns,
// no tokens and no cost while it worked: the transcript was somewhere the
// tailer's root did not reach.
package ingest

import (
	"context"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/store"
)

// One file on Windows however a hook spells it: drive letter, case and
// separators differ between Claude Code's own `transcript_path`, the
// profile directory Go resolves and a path typed by hand.
func TestKeyForComparesWindowsPathsAsWindowsDoes(t *testing.T) {
	a := `C:\Users\Dima\.claude\projects\C--Users-Dima-dev-app\0b6c7e2a-1111-4222-8333-944445555666.jsonl`
	b := `c:/users/dima/.claude/projects/c--users-dima-dev-app/0B6C7E2A-1111-4222-8333-944445555666.jsonl`
	if keyFor(a, "windows") != keyFor(b, "windows") {
		t.Fatalf("one Windows file, two keys:\n%q\n%q", keyFor(a, "windows"), keyFor(b, "windows"))
	}
	// Elsewhere case is part of the name.
	if keyFor("/Users/a/x.jsonl", "darwin") == keyFor("/users/a/x.jsonl", "darwin") {
		t.Fatal("a case-sensitive filesystem was compared without case")
	}
}

func TestUnderTakesAWindowsRootInAnyCase(t *testing.T) {
	root := `C:\Users\Dima\.claude\projects`
	for _, tc := range []struct {
		path string
		want bool
	}{
		{`c:\users\dima\.claude\projects\C--Users-Dima-dev\s.jsonl`, true},
		{`C:/Users/Dima/.claude/projects/C--Users-Dima-dev/s.jsonl`, true},
		// A profile's projects/, or a sibling that only starts the same: not under it.
		{`C:\Users\Dima\AppData\Roaming\caprock\profiles\p1\projects\x\s.jsonl`, false},
		{`C:\Users\Dima\.claude\projects-old\x\s.jsonl`, false},
		{root, false},
		{"", false},
	} {
		if got := under(tc.path, root, "windows"); got != tc.want {
			t.Errorf("under(%q) = %v, want %v", tc.path, got, tc.want)
		}
	}
}

// Only the session's own transcript, by an absolute path.
func TestFollowablePathIsTheSessionsOwnTranscript(t *testing.T) {
	sid := "0b6c7e2a-1111-4222-8333-944445555666"
	abs := filepath.Join(t.TempDir(), "proj", sid+".jsonl")
	if !FollowablePath(abs, sid) {
		t.Errorf("%q refused for its own session", abs)
	}
	for _, p := range []string{
		"",
		filepath.Join("proj", sid+".jsonl"), // relative
		filepath.Join(t.TempDir(), "proj", "other.jsonl"),           // another file
		filepath.Join(t.TempDir(), sid, "subagents", "agent.jsonl"), // a subagent's
		filepath.Join(t.TempDir(), "proj", sid+".txt"),
	} {
		if FollowablePath(p, sid) {
			t.Errorf("%q taken for session %s", p, sid)
		}
	}
	if FollowablePath(abs, "") {
		t.Error("a path taken with no session")
	}
}

// The case that broke: the transcript is outside the root the daemon walks.
// The hook's path is the one read, and the session gets its turns.
func TestFollowReadsATranscriptOutsideTheRoot(t *testing.T) {
	root := t.TempDir()
	elsewhere := filepath.Join(t.TempDir(), "other-home", ".claude", "projects", "C--Users-Dima-dev-app")
	sid := "0b6c7e2a-1111-4222-8333-944445555666"
	path := filepath.Join(elsewhere, sid+".jsonl")

	tl, st := newTailerAt(t, root)
	tl.PollInterval = 20 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go func() { _ = tl.Run(ctx) }()
	waitFor(t, 5*time.Second, func() bool { return tl.Stats().BackfillDone })

	// Named by SessionStart before Claude Code has written a line.
	if tl.Covers(path) {
		t.Fatalf("%q reads as under the root %q", path, root)
	}
	if !tl.Follow(path, sid) {
		t.Fatal("Follow refused the session's own transcript")
	}
	if tl.Follow(path, sid) {
		t.Error("the same transcript was followed twice")
	}
	time.Sleep(60 * time.Millisecond) // a few polls with no file yet
	writeTranscript(t, path, sid)

	waitFor(t, 20*time.Second, func() bool { return tl.Stats().EventsStored > 0 })
	s, err := store.GetSession(ctx, st.DB(), sid)
	if err != nil {
		t.Fatalf("the followed transcript made no session: %v", err)
	}
	if !s.HasTranscript {
		t.Error("has_transcript is still false after the followed transcript was read")
	}
	if !strings.EqualFold(filepath.Clean(s.TranscriptPath), filepath.Clean(path)) {
		t.Errorf("transcript_path = %q, want %q", s.TranscriptPath, path)
	}
	stats, err := store.GetStats(ctx, st.DB(), sid)
	if err != nil || stats.Turns == 0 {
		t.Errorf("turns = %d (err %v): the session is still unmeasured", stats.Turns, err)
	}
	if got := tl.Stats(); got.Followed != 1 || got.Root != root {
		t.Errorf("stats: followed=%d root=%q, want 1 and %q", got.Followed, got.Root, root)
	}
}

// A transcript the walk already holds is not opened a second time, however
// the hook spells it: two readers of one file would each keep an offset.
func TestFollowLeavesAKnownTranscriptAlone(t *testing.T) {
	root := t.TempDir()
	sid := "0b6c7e2a-1111-4222-8333-944445555666"
	path := filepath.Join(root, "-proj", sid+".jsonl")
	writeTranscript(t, path, sid)
	tl, _ := newTailerAt(t, root)
	if err := tl.discover(nil); err != nil {
		t.Fatal(err)
	}
	spelled := filepath.Join(root, "-proj", ".", sid+".jsonl")
	if runtime.GOOS == "windows" {
		// What a hook on Windows can send: the drive letter lower-case, forward slashes.
		spelled = strings.ToLower(filepath.ToSlash(path))
	}
	if tl.Follow(spelled, sid) {
		t.Errorf("Follow(%q) opened a second reader on %q", spelled, path)
	}
	if n := tl.Stats().FilesKnown; n != 1 {
		t.Errorf("files known = %d, want 1", n)
	}
	if !tl.Covers(spelled) {
		t.Errorf("Covers(%q) = false under %q", spelled, root)
	}
}

// A followed file is looked at on every poll while it is new, and only
// then: a session that ended before its first prompt never writes one, and
// the poll must not stat it forever.
func TestAFollowedFileIsHotWhileNew(t *testing.T) {
	sid := "0b6c7e2a-1111-4222-8333-944445555666"
	for _, tc := range []struct {
		name string
		age  time.Duration
		read bool
	}{{"new", 0, true}, {"old", 2 * hotWindow, false}} {
		t.Run(tc.name, func(t *testing.T) {
			tl, _ := newTailerAt(t, t.TempDir())
			tl.watching = true // as with fsnotify running: only hot files are polled
			path := filepath.Join(t.TempDir(), sid+".jsonl")
			if !tl.Follow(path, sid) {
				t.Fatal("refused")
			}
			clear(tl.dirty)
			tl.files[filepath.Clean(path)].followed = time.Now().Add(-tc.age)
			writeTranscript(t, path, sid)
			tl.passHot(context.Background())
			if got := tl.Stats().EventsStored > 0; got != tc.read {
				t.Errorf("read on the poll = %v, want %v", got, tc.read)
			}
		})
	}
}
