package api

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/branches"
	"github.com/dspv/caprock/internal/github"
)

// A branch already inside an open batch pull request's branch has a PR,
// though not its own: in_pr names it, and it is not listed as having none
// (owner, 2026-10-19: the release plan listed fix/windows-key-chips, which
// batch/0.137.0 carried).
func TestMarkLandedInPR(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	dir := t.TempDir()
	run := func(args ...string) string {
		t.Helper()
		out, err := exec.Command("git", append([]string{"-C", dir, "-c", "user.name=Ada", "-c", "user.email=ada@example.com", "-c", "commit.gpgsign=false"}, args...)...).CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	run("init", "-q", "-b", "main")
	run("commit", "-q", "--allow-empty", "-m", "one")
	run("checkout", "-q", "-b", "fix/in-batch")
	run("commit", "-q", "--allow-empty", "-m", "fix: a change the batch carries")
	inBatch := run("rev-parse", "HEAD")
	run("checkout", "-q", "-b", "batch/1")
	run("commit", "-q", "--allow-empty", "-m", "fix: the batch's own change")
	batch := run("rev-parse", "HEAD")
	run("checkout", "-q", "-b", "fix/alone", "main")
	if err := os.WriteFile(filepath.Join(dir, "alone.txt"), []byte("alone\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", "alone.txt")
	run("commit", "-q", "-m", "fix: a change nobody carries yet")
	alone := run("rev-parse", "HEAD")

	now := time.Now()
	one := 1
	row := func(name, sha string, pr *github.BranchPR) SessionBranch {
		return SessionBranch{Branch: branches.Branch{Name: name, SHA: sha, Ahead: &one, CommittedMS: now.UnixMilli()}, PR: pr}
	}
	bs := []SessionBranch{
		row("batch/1", batch, &github.BranchPR{Number: 77, State: "open"}),
		row("fix/in-batch", inBatch, nil),
		row("fix/alone", alone, nil),
	}
	markLanded(context.Background(), dir, "main", bs, now)
	if bs[1].InPR != 77 || bs[1].Landed {
		t.Fatalf("in batch = %+v", bs[1])
	}
	if bs[2].InPR != 0 || bs[2].Landed {
		t.Fatalf("alone = %+v", bs[2])
	}
	if bs[0].InPR != 0 {
		t.Fatalf("the batch itself = %+v", bs[0])
	}
}
