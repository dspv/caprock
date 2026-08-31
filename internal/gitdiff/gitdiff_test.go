package gitdiff

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
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

// An untracked file's content is its change. The panel used to say
// "untracked — no diff against HEAD": true, and an answer to a question the
// reader did not ask. git will not diff an untracked file, so Diff asks it to
// diff against the null device — which exits 1 whenever the inputs differ,
// i.e. always here, and that exit status once threw the patch away.
func TestUntrackedFileCarriesItsContent(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	dir := t.TempDir()
	run(t, dir, "init", "-q")
	_ = os.WriteFile(filepath.Join(dir, "seed.txt"), []byte("seed\n"), 0o600)
	run(t, dir, "add", "seed.txt")
	run(t, dir, "commit", "-q", "-m", "init")
	_ = os.WriteFile(filepath.Join(dir, "fresh.txt"), []byte("alpha\nbeta\ngamma\n"), 0o600)

	res, err := Diff(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	var fd *FileDiff
	for i := range res.Files {
		if res.Files[i].Path == "fresh.txt" {
			fd = &res.Files[i]
		}
	}
	if fd == nil {
		t.Fatalf("untracked file missing: %+v", res.Files)
	}
	if fd.Status != "untracked" {
		t.Errorf("status %q, want untracked", fd.Status)
	}
	if fd.Additions != 3 {
		t.Errorf("additions %d, want 3", fd.Additions)
	}
	if !strings.Contains(fd.Patch, "+alpha") || !strings.Contains(fd.Patch, "+gamma") {
		t.Errorf("patch does not carry the file's lines:\n%s", fd.Patch)
	}
	// The `diff --git` line names the file on both sides, the way an ordinary
	// patch does. `--- /dev/null` stays: that is git's own notation for "this
	// file did not exist before", and every diff viewer expects it.
	if !strings.Contains(fd.Patch, "diff --git a/fresh.txt b/fresh.txt") {
		t.Errorf("header does not read like an ordinary patch:\n%s", fd.Patch)
	}
}

// A branch is measured from where it forked, not from its own tip. Diffing
// against HEAD alone reported "no changes" for a branch whose work was
// committed — the exact case a session panel exists to show.
func TestBranchDiffCoversItsOwnCommits(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	dir := t.TempDir()
	run(t, dir, "init", "-q", "-b", "master")
	_ = os.WriteFile(filepath.Join(dir, "a.txt"), []byte("one\n"), 0o600)
	run(t, dir, "add", "a.txt")
	run(t, dir, "commit", "-q", "-m", "init")

	// On the trunk itself, its commits are history rather than changes.
	res, err := Diff(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Files) != 0 || res.BaseBranch != "" {
		t.Fatalf("clean trunk: files=%d base=%q", len(res.Files), res.BaseBranch)
	}

	run(t, dir, "checkout", "-q", "-b", "feature")
	_ = os.WriteFile(filepath.Join(dir, "a.txt"), []byte("one\ntwo\n"), 0o600)
	_ = os.WriteFile(filepath.Join(dir, "b.txt"), []byte("new\n"), 0o600)
	run(t, dir, "add", ".")
	run(t, dir, "commit", "-q", "-m", "work")

	// Everything is committed, so a HEAD-based diff is empty. The branch's
	// two files must still be reported.
	res, err = Diff(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Files) != 2 {
		t.Fatalf("committed branch work missing: %+v", res.Files)
	}
	if res.BaseBranch != "master" {
		t.Errorf("base branch %q, want master", res.BaseBranch)
	}
	if res.Base == "" {
		t.Error("base not named for the reader")
	}
}
