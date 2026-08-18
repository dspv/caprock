package agents

import (
	"bytes"
	"context"
	"errors"
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
	// -B creates or resets a branch named after the worktree.
	if _, err := gitOut(ctx, repo, "worktree", "add", "-B", "caprock/"+name, dir); err != nil {
		return "", err
	}
	return dir, nil
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
