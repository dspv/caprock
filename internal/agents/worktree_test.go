package agents

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// gitRepo builds a throwaway repo on branch main with one commit and returns a
// runner bound to it.
func gitRepo(t *testing.T) (string, func(...string) string) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	dir := t.TempDir()
	run := func(a ...string) string {
		t.Helper()
		c := exec.Command("git", append([]string{"-C", dir}, a...)...)
		c.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		out, err := c.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", a, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	run("init", "-q", "-b", "main")
	if err := os.WriteFile(filepath.Join(dir, "f"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	run("add", "f")
	run("commit", "-q", "-m", "init")
	return dir, run
}

// TestCreateWorktreePreservesExistingBranchCommits is the regression test for
// the `git worktree add -B` data loss: -B force-reset an existing branch to
// HEAD, dropping the user's commits from the branch tip (recoverable only via
// the reflog). Worker names are predictable and nothing removes branches, so a
// second run with the same worker name hit this in ordinary use.
//
// Restoring `-B` in place of `-b` makes this fail with "user commit was
// destroyed", naming both SHAs.
func TestCreateWorktreePreservesExistingBranchCommits(t *testing.T) {
	dir, run := gitRepo(t)

	// The user has their own commit on the branch a worker would claim.
	run("branch", "caprock/worker-1")
	run("checkout", "-q", "caprock/worker-1")
	if err := os.WriteFile(filepath.Join(dir, "precious"), []byte("user work"), 0o600); err != nil {
		t.Fatal(err)
	}
	run("add", "precious")
	run("commit", "-q", "-m", "PRECIOUS USER COMMIT")
	before := run("rev-parse", "caprock/worker-1")
	run("checkout", "-q", "main")

	_, err := createWorktree(context.Background(), dir, "worker-1")
	if err == nil {
		t.Fatal("createWorktree silently took over a branch that already existed; it must refuse by name")
	}
	// The refusal has to be actionable: it names the branch the user must deal with.
	if !strings.Contains(err.Error(), "caprock/worker-1") {
		t.Errorf("error does not name the branch, so the user cannot act on it: %v", err)
	}

	after := run("rev-parse", "caprock/worker-1")
	if before != after {
		t.Errorf("user commit was destroyed: branch tip moved %s → %s", before, after)
	}
	if log := run("log", "--oneline", "caprock/worker-1"); !strings.Contains(log, "PRECIOUS USER COMMIT") {
		t.Errorf("user commit is no longer reachable from the branch; log:\n%s", log)
	}
}

// TestCreateWorktreeReattachesToItsOwn proves the refusal above does not make a
// worker un-restartable: the worktree Caprock itself created at the path it
// would choose is reused, so a daemon restart or a re-spawn of the same worker
// picks its work back up instead of erroring.
func TestCreateWorktreeReattachesToItsOwn(t *testing.T) {
	dir, run := gitRepo(t)

	first, err := createWorktree(context.Background(), dir, "worker-1")
	if err != nil {
		t.Fatal(err)
	}
	// Work happens in the worktree.
	if err := os.WriteFile(filepath.Join(first, "wip"), []byte("in progress"), 0o600); err != nil {
		t.Fatal(err)
	}
	second, err := createWorktree(context.Background(), dir, "worker-1")
	if err != nil {
		t.Fatalf("re-spawning the same worker must reuse its worktree, not fail: %v", err)
	}
	if second != first {
		t.Errorf("worktree path changed on reuse: %q → %q", first, second)
	}
	if _, err := os.Stat(filepath.Join(second, "wip")); err != nil {
		t.Errorf("in-progress work was lost on reuse: %v", err)
	}
	_ = run("status")
}

// TestCreateWorktreeRefusesBranchCheckedOutElsewhere covers the case where the
// user has the branch checked out in their own worktree at another path.
func TestCreateWorktreeRefusesBranchCheckedOutElsewhere(t *testing.T) {
	dir, run := gitRepo(t)
	other := filepath.Join(t.TempDir(), "user-worktree")
	run("worktree", "add", "-q", "-b", "caprock/worker-1", other)

	_, err := createWorktree(context.Background(), dir, "worker-1")
	if err == nil {
		t.Fatal("took over a branch checked out in the user's own worktree")
	}
	if !strings.Contains(err.Error(), "worker-1") {
		t.Errorf("unhelpful error: %v", err)
	}
}

func TestCreateWorktreeRejectsPathSeparators(t *testing.T) {
	dir, _ := gitRepo(t)
	for _, bad := range []string{"bad/name", `bad\name`, "c:name"} {
		if _, err := createWorktree(context.Background(), dir, bad); err == nil {
			t.Errorf("accepted path separator in worker name %q", bad)
		}
	}
}
