package projects

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

// An empty folder is a free destination, as it is for git itself: the Add
// project sheet says "exists, empty — will clone here", and the clone must
// then not refuse it. A folder holding anything, a hidden file included, is
// still refused before git runs.
func TestCloneIntoAnEmptyFolderOnly(t *testing.T) {
	parent := t.TempDir()
	if err := os.Mkdir(filepath.Join(parent, "empty"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(parent, "full"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(parent, "full", ".DS_Store"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if !EmptyDir(filepath.Join(parent, "empty")) || EmptyDir(filepath.Join(parent, "full")) || EmptyDir(filepath.Join(parent, "missing")) {
		t.Fatal("EmptyDir misjudged a folder")
	}
	s, _, _ := newService(t)
	start(t, s)
	if _, _, err := s.Clone("op-empty", "https://example.invalid/src", parent, "empty"); err != nil {
		t.Fatalf("clone into an empty folder refused: %v", err)
	}
	if _, _, err := s.Clone("op-full", "https://example.invalid/src", parent, "full"); err == nil {
		t.Fatal("clone into a folder with a file in it was accepted")
	}
}

// ListedAt answers for the listed root and for a folder inside its
// repository — adding either returns that project — and not for a stranger.
func TestListedAtFindsTheProjectAddingWouldReturn(t *testing.T) {
	needGit(t)
	base := t.TempDir()
	repo := newRepo(t, filepath.Join(base, "repo"))
	sub := filepath.Join(repo, "sub")
	if err := os.Mkdir(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	s, _, _ := newService(t)
	start(t, s)
	v, _, err := s.Add(context.Background(), repo)
	if err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{repo, sub} {
		if p, ok := s.ListedAt(dir); !ok || p.ID != v.ID {
			t.Errorf("ListedAt(%s) = %+v %v, want project %d", dir, p, ok, v.ID)
		}
	}
	if _, ok := s.ListedAt(base); ok {
		t.Error("a folder that is no project was reported as listed")
	}
}

// Close stops a clone still running and returns only once its git has exited:
// a git left writing into the destination made the test's TempDir cleanup
// fail ("unlinkat .../empty/.git/hooks: directory not empty") on CI, and in
// the daemon it is a git still writing after shutdown. The fake git writes
// into the destination until it is killed.
func TestCloseStopsARunningCloneAndWaitsForIt(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the writing git is a shell script")
	}
	fake := filepath.Join(t.TempDir(), "git")
	script := "#!/bin/sh\nd=\"$5\"\nmkdir -p \"$d/.git/hooks\"\ni=0\nwhile :; do i=$((i+1)); echo x > \"$d/.git/hooks/h$i\"; done\n"
	if err := os.WriteFile(fake, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	old := gitBin
	gitBin = fake
	t.Cleanup(func() { gitBin = old })
	parent := t.TempDir()
	s, _, _ := newService(t)
	start(t, s)
	op, _, err := s.Clone("op-writing", "https://example.invalid/src", parent, "dest")
	if err != nil {
		t.Fatal(err)
	}
	hooks := filepath.Join(op.Dest, ".git", "hooks")
	deadline := time.Now().Add(10 * time.Second)
	for {
		if es, _ := os.ReadDir(hooks); len(es) > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the fake git never started writing")
		}
		time.Sleep(5 * time.Millisecond)
	}
	s.Close()
	// Nothing writes any more: the folder goes, and stays gone.
	if err := os.RemoveAll(op.Dest); err != nil {
		t.Fatalf("a git still writes after Close: %v", err)
	}
	if _, err := os.Stat(op.Dest); !os.IsNotExist(err) {
		t.Fatalf("the destination came back after Close: %v", err)
	}
	if got, ok := s.GetOp("op-writing"); !ok || got.State == OpRunning {
		t.Fatalf("the clone is still running after Close: %+v", got)
	}
	if _, _, err := s.Clone("op-after", "https://example.invalid/src", parent, "later"); err == nil {
		t.Fatal("a clone started after Close")
	}
}
