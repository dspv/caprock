package gitdiff

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func run(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

func TestDiff(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	dir := t.TempDir()
	if _, err := Diff(context.Background(), dir); !errors.Is(err, ErrNotARepo) {
		t.Fatalf("non-repo: %v", err)
	}
	run(t, dir, "init", "-q")
	_ = os.WriteFile(filepath.Join(dir, "a.txt"), []byte("one\ntwo\n"), 0o600)
	run(t, dir, "add", "a.txt")
	run(t, dir, "commit", "-q", "-m", "init")
	_ = os.WriteFile(filepath.Join(dir, "a.txt"), []byte("one\nthree\nfour\n"), 0o600)
	_ = os.WriteFile(filepath.Join(dir, "new.txt"), []byte("hi\n"), 0o600)
	res, err := Diff(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Files) != 2 {
		t.Fatalf("files: %+v", res.Files)
	}
	var mod, unt *FileDiff
	for i := range res.Files {
		switch res.Files[i].Path {
		case "a.txt":
			mod = &res.Files[i]
		case "new.txt":
			unt = &res.Files[i]
		}
	}
	if mod == nil || mod.Status != "modified" || mod.Additions != 2 || mod.Deletions != 1 || mod.Patch == "" {
		t.Fatalf("modified: %+v", mod)
	}
	if unt == nil || unt.Status != "untracked" {
		t.Fatalf("untracked: %+v", unt)
	}
	if res.Stat == "" || res.Root == "" {
		t.Fatalf("stat/root missing: %+v", res)
	}
	// Subdirectory cwd resolves to the same repo.
	sub := filepath.Join(dir, "sub")
	_ = os.MkdirAll(sub, 0o700)
	res2, err := Diff(context.Background(), sub)
	if err != nil || len(res2.Files) != 2 {
		t.Fatalf("subdir: %v %+v", err, res2)
	}
}
