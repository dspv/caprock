package sessionlink

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/store"
)

func newLinker(t *testing.T) (*Linker, *store.Store) {
	t.Helper()
	st, err := store.Open(context.Background(), filepath.Join(t.TempDir(), "caprock.db"), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return New(st, nil), st
}

func spawn(t *testing.T, st *store.Store, id, cwd string) {
	t.Helper()
	if err := store.UpsertSession(context.Background(), st.DB(), id, store.SessionPatch{Cwd: cwd, Agent: "codex"}); err != nil {
		t.Fatal(err)
	}
}

var t0 = time.Date(2026, 10, 4, 12, 0, 0, 0, time.UTC)

func TestAThreadStartedWithTheSpawnIsLinked(t *testing.T) {
	l, st := newLinker(t)
	spawn(t, st, "cap-1", "/w/p")
	l.Expect("codex", "cap-1", "/w/p", t0, true)
	got := l.Resolve(context.Background(), "codex", Candidate{NativeID: "th-1", Cwd: "/w/p", Started: t0.Add(2 * time.Second), Eligible: true})
	if got != "cap-1" {
		t.Fatalf("resolved to %q, want cap-1", got)
	}
	if l.Waiting("codex") {
		t.Error("a linked spawn is still waiting")
	}
	// Stored, so a fresh linker (a restart) finds it.
	if id, _ := store.SessionForNative(context.Background(), st.DB(), "codex", "th-1"); id != "cap-1" {
		t.Errorf("link not stored: %q", id)
	}
	if got := New(st, nil).Resolve(context.Background(), "codex", Candidate{NativeID: "th-1"}); got != "cap-1" {
		t.Errorf("after a restart: %q", got)
	}
}

func TestWhatIsNotTaken(t *testing.T) {
	for name, c := range map[string]Candidate{
		"another folder":     {NativeID: "th", Cwd: "/w/other", Started: t0.Add(time.Second), Eligible: true},
		"too late":           {NativeID: "th", Cwd: "/w/p", Started: t0.Add(Window + time.Second), Eligible: true},
		"before the spawn":   {NativeID: "th", Cwd: "/w/p", Started: t0.Add(-Skew - time.Second), Eligible: true},
		"not the TUI's":      {NativeID: "th", Cwd: "/w/p", Started: t0.Add(time.Second)},
		"no folder recorded": {NativeID: "th", Started: t0.Add(time.Second), Eligible: true},
	} {
		t.Run(name, func(t *testing.T) {
			l, st := newLinker(t)
			spawn(t, st, "cap-1", "/w/p")
			l.Expect("codex", "cap-1", "/w/p", t0, true)
			if got := l.Resolve(context.Background(), "codex", c); got != "th" {
				t.Fatalf("taken: %q", got)
			}
			if !l.Waiting("codex") {
				t.Error("the spawn stopped waiting without a link")
			}
		})
	}
}

// A thread the store already holds under its own id existed before the spawn
// (a resumed thread, or one read earlier), whatever its timestamps say.
func TestAKnownThreadIsNeverTaken(t *testing.T) {
	l, st := newLinker(t)
	spawn(t, st, "cap-1", "/w/p")
	spawn(t, st, "th-old", "/w/p")
	l.Expect("codex", "cap-1", "/w/p", t0, true)
	if got := l.Resolve(context.Background(), "codex", Candidate{NativeID: "th-old", Cwd: "/w/p", Started: t0, Eligible: true}); got != "th-old" {
		t.Fatalf("a known thread was taken: %q", got)
	}
}

// Two spawns in one folder: each thread goes to the spawn it started closest
// after, and each spawn takes one thread.
func TestTwoSpawnsInOneFolder(t *testing.T) {
	l, st := newLinker(t)
	spawn(t, st, "cap-1", "/w/p")
	spawn(t, st, "cap-2", "/w/p")
	l.Expect("codex", "cap-1", "/w/p", t0, true)
	l.Expect("codex", "cap-2", "/w/p", t0.Add(30*time.Second), true)
	ctx := context.Background()
	if got := l.Resolve(ctx, "codex", Candidate{NativeID: "th-2", Cwd: "/w/p", Started: t0.Add(31 * time.Second), Eligible: true}); got != "cap-2" {
		t.Errorf("second thread went to %q", got)
	}
	if got := l.Resolve(ctx, "codex", Candidate{NativeID: "th-1", Cwd: "/w/p", Started: t0.Add(time.Second), Eligible: true}); got != "cap-1" {
		t.Errorf("first thread went to %q", got)
	}
}

// OpenCode's spawns are claimed exactly and never matched on folder and time.
func TestAClaimOnlySpawnIsNotMatched(t *testing.T) {
	l, st := newLinker(t)
	spawn(t, st, "cap-1", "/w/p")
	l.Expect("opencode", "cap-1", "/w/p", t0, false)
	ctx := context.Background()
	if got := l.Resolve(ctx, "opencode", Candidate{NativeID: "ses_1", Cwd: "/w/p", Started: t0, Eligible: true}); got != "ses_1" {
		t.Fatalf("matched: %q", got)
	}
	if !l.Claim(ctx, "opencode", "cap-1", "ses_1") {
		t.Fatal("claim refused")
	}
	if got := l.Resolve(ctx, "opencode", Candidate{NativeID: "ses_1"}); got != "cap-1" {
		t.Fatalf("after the claim: %q", got)
	}
	// Written once: a second claim never moves the link.
	if l.Claim(ctx, "opencode", "cap-1", "ses_2") {
		t.Error("a link was moved to another session")
	}
}

func TestAnEndedSpawnWaitsOutTheGrace(t *testing.T) {
	l, st := newLinker(t)
	now := t0
	l.Now = func() time.Time { return now }
	spawn(t, st, "cap-1", "/w/p")
	l.Expect("codex", "cap-1", "/w/p", t0, true)
	l.Ended("cap-1")
	now = t0.Add(Grace / 2)
	if !l.Waiting("codex") {
		t.Fatal("dropped inside the grace period: a session typed into and closed within one tick would never be linked")
	}
	now = t0.Add(Grace + time.Second)
	if l.Waiting("codex") {
		t.Fatal("still waiting after the grace period")
	}
}

// A spawn in /tmp/x and a thread that recorded /private/tmp/x are one folder.
func TestASymlinkedFolderMatches(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks need privileges on Windows")
	}
	real := t.TempDir()
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(real, link); err != nil {
		t.Skip(err)
	}
	l, st := newLinker(t)
	spawn(t, st, "cap-1", link)
	l.Expect("codex", "cap-1", link, t0, true)
	resolved, _ := filepath.EvalSymlinks(real)
	if got := l.Resolve(context.Background(), "codex", Candidate{NativeID: "th", Cwd: resolved, Started: t0, Eligible: true}); got != "cap-1" {
		t.Fatalf("got %q", got)
	}
}
