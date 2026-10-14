package store

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

// overlapFixture is a repository with a subfolder and a linked worktree, laid
// out the way git leaves them: a `.git` directory at the root, a `.git` file
// in the worktree.
func overlapFixture(t *testing.T) (root, sub, wt string) {
	t.Helper()
	root = t.TempDir()
	sub = filepath.Join(root, "ui")
	wt = filepath.Join(root, ".caprock-worktrees", "fix-login")
	for _, d := range []string{filepath.Join(root, ".git", "worktrees", "fix-login"), sub, wt} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	gitdir := "gitdir: " + filepath.Join(root, ".git", "worktrees", "fix-login") + "\n"
	if err := os.WriteFile(filepath.Join(wt, ".git"), []byte(gitdir), 0o644); err != nil {
		t.Fatal(err)
	}
	return root, sub, wt
}

func TestCheckoutOf(t *testing.T) {
	root, sub, wt := overlapFixture(t)
	if got, want := CheckoutOf(sub), normalizeCwd(root); got != want {
		t.Fatalf("subfolder: %q, want the clone's root %q", got, want)
	}
	if got, want := CheckoutOf(wt), normalizeCwd(wt); got != want {
		t.Fatalf("linked worktree: %q, want its own folder %q", got, want)
	}
	plain := t.TempDir()
	if got := CheckoutOf(plain); got != normalizeCwd(plain) {
		t.Fatalf("no repository: %q, want the folder itself", got)
	}
	if CheckoutOf("") != "" {
		t.Fatal("empty cwd names a checkout")
	}
}

func TestOverlaps(t *testing.T) {
	ctx := context.Background()
	st := openTest(t)
	root, sub, wt := overlapFixture(t)
	const now = int64(1_800_000_000_000)
	shared := filepath.ToSlash(filepath.Join(root, "main.go"))
	live := []Session{
		{SessionID: "old", Cwd: root, StartedAt: 100, Status: "active"},
		{SessionID: "new", Cwd: sub, StartedAt: 200, Status: "active"},
		{SessionID: "wt", Cwd: wt, StartedAt: 150, Status: "active"},
		{SessionID: "gone", Cwd: root, StartedAt: 50, Status: "ended"},
	}
	touch := func(id, path string, ts int64) {
		if _, err := TouchFile(ctx, st.DB(), id, path, ts); err != nil {
			t.Fatal(err)
		}
	}
	touch("old", shared, now-5*60_000)
	touch("new", shared, now-60_000)
	// Edited by both, but by one of them before the window.
	touch("old", root+"/stale.go", now-OverlapWindowMs-1)
	touch("new", root+"/stale.go", now-1)
	// Edited only by one.
	touch("new", root+"/ui/app.tsx", now-1)
	// The worktree's session edits the same name in its own folder: no collision.
	touch("wt", filepath.ToSlash(filepath.Join(wt, "main.go")), now-1)
	touch("gone", shared, now-1)

	got, err := Overlaps(ctx, st.DB(), live, now-OverlapWindowMs)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("sessions with neighbours: %+v, want old and new only", got)
	}
	if _, ok := got["wt"]; ok {
		t.Fatal("a session in its own worktree was flagged")
	}
	o := got["new"]
	if o.Checkout != normalizeCwd(root) || len(o.With) != 1 || o.With[0].SessionID != "old" || o.With[0].StartedAt != 100 {
		t.Fatalf("new: %+v", o)
	}
	if f := o.With[0].Files; len(f) != 1 || f[0] != normalizeCwd(shared) {
		t.Fatalf("files touched by both: %v, want only %s", f, shared)
	}
	if f := got["old"].With[0].Files; len(f) != 1 {
		t.Fatalf("old: %v", f)
	}

	// Sharing only the folder: a neighbour, no files.
	got, err = Overlaps(ctx, st.DB(), live[:2], now+OverlapWindowMs)
	if err != nil {
		t.Fatal(err)
	}
	if o := got["old"]; len(o.With) != 1 || len(o.With[0].Files) != 0 {
		t.Fatalf("folder only: %+v", o)
	}

	// Alone in a checkout: nothing.
	got, err = Overlaps(ctx, st.DB(), live[2:], now-OverlapWindowMs)
	if err != nil || len(got) != 0 {
		t.Fatalf("alone: %+v %v", got, err)
	}
}
