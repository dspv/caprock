package agents

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// createWorktree runs `git worktree add` under repoDir and returns the new path.
// The worktree lives at <repo>/.caprock-worktrees/<name>.
func createWorktree(ctx context.Context, repoDir, name string) (string, error) {
	if strings.ContainsAny(name, `/\:`) {
		return "", errors.New("agents: worktree name must not contain path separators")
	}
	top, err := gitOut(ctx, repoDir, "rev-parse", "--show-toplevel")
	if err != nil {
		return "", errors.New("agents: worktree requested but cwd is not a git repository")
	}
	repo := strings.TrimSpace(top)
	dir := filepath.Join(repo, ".caprock-worktrees", name)
	branch := "caprock/" + name

	// Worker names are predictable ("worker-1") and nothing removed worktrees or
	// branches, so a second run reliably collided with the first. The original
	// `-B` force-reset the branch to HEAD, which silently dropped every commit on
	// it — a user's work reachable only through the reflog. A worker's branch is
	// never worth someone's commits, so this never resets: it reattaches to the
	// worktree it already owns, and otherwise refuses by name.
	if existing, err := worktreeFor(ctx, repo, branch); err == nil && existing != "" {
		// Already checked out somewhere. Only reuse the path we would have chosen;
		// anything else is the user's own checkout of that branch.
		if filepath.Clean(existing) != filepath.Clean(dir) {
			return "", fmt.Errorf(
				"agents: branch %s is already checked out at %s; remove that worktree or use a different worker name",
				branch, existing)
		}
		if fi, err := os.Stat(dir); err == nil && fi.IsDir() {
			return dir, nil
		}
	}
	if branchExists(ctx, repo, branch) {
		return "", fmt.Errorf(
			"agents: branch %s already exists; delete it (git branch -D %s) or use a different worker name",
			branch, branch)
	}
	// -b (not -B) fails loudly rather than resetting, which is the behaviour we
	// want even if the checks above are ever bypassed by a race.
	if _, err := gitOut(ctx, repo, "worktree", "add", "-b", branch, dir); err != nil {
		return "", err
	}
	return dir, nil
}

// branchExists reports whether refs/heads/<branch> is present.
func branchExists(ctx context.Context, repo, branch string) bool {
	_, err := gitOut(ctx, repo, "show-ref", "--verify", "--quiet", "refs/heads/"+branch)
	return err == nil
}

// worktreeFor returns the path of the worktree that has branch checked out, or
// "" when no worktree holds it. It parses `git worktree list --porcelain`, whose
// records are blank-line separated with "worktree <path>" and "branch <ref>".
func worktreeFor(ctx context.Context, repo, branch string) (string, error) {
	out, err := gitOut(ctx, repo, "worktree", "list", "--porcelain")
	if err != nil {
		return "", err
	}
	cur := ""
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(line, "worktree "):
			cur = strings.TrimPrefix(line, "worktree ")
		case strings.HasPrefix(line, "branch "):
			if strings.TrimPrefix(line, "branch ") == "refs/heads/"+branch {
				return cur, nil
			}
		}
	}
	return "", nil
}

func gitOut(ctx context.Context, dir string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := cmd.Run(); err != nil {
		return "", errors.New(strings.TrimSpace(errb.String()))
	}
	return out.String(), nil
}
