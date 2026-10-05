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

// WorktreeSpec asks for a worktree on any branch (WP-08): an existing local
// branch, a branch only a remote has (created locally, tracking it), or with
// Create a new branch from Base (HEAD when empty).
type WorktreeSpec struct {
	Branch string
	Create bool
	Base   string
}

// Worktree is a worktree AddWorktree made.
type Worktree struct {
	Path   string `json:"path"`
	Branch string `json:"branch"`
	// Tracks is the remote branch a new local branch was set to track, empty
	// when none.
	Tracks string `json:"tracks,omitempty"`
}

// WorktreeName is the directory name a branch's worktree gets under
// <repo>/.caprock-worktrees: the branch with its slashes made dashes, so
// `feat/x` is `feat-x`.
func WorktreeName(branch string) string {
	return strings.NewReplacer("/", "-", `\`, "-", ":", "-").Replace(branch)
}

// AddWorktree checks out a branch in a new worktree at
// <repo>/.caprock-worktrees/<WorktreeName(branch)>.
//
// createWorktree, which an agent's `worktree` field uses, makes a branch of
// its own name (`caprock/<worker>`). This is the general form a person asks
// for from the sidebar or the phone. It never resets a branch (no -B) and
// never forces: a branch checked out in another worktree is refused with
// git's own message, which names where.
func AddWorktree(ctx context.Context, repoDir string, spec WorktreeSpec) (Worktree, error) {
	branch := strings.TrimSpace(spec.Branch)
	if err := checkBranchName(ctx, repoDir, branch); err != nil {
		return Worktree{}, err
	}
	base := strings.TrimSpace(spec.Base)
	if strings.HasPrefix(base, "-") {
		return Worktree{}, fmt.Errorf("base %q is not a branch or commit", base)
	}
	top, err := gitOut(ctx, repoDir, "rev-parse", "--show-toplevel")
	if err != nil {
		return Worktree{}, fmt.Errorf("%s is not a git repository", repoDir)
	}
	repo := filepath.Clean(strings.TrimSpace(top))
	dir := filepath.Join(repo, WorktreeDir, WorktreeName(branch))
	if _, err := os.Stat(dir); err == nil {
		return Worktree{}, fmt.Errorf("%s already exists; remove it or pick another branch", dir)
	}
	ensureExcluded(ctx, repo)
	local := branchExists(ctx, repo, branch)
	switch {
	case spec.Create && local:
		return Worktree{}, fmt.Errorf("branch %s already exists; pick it without creating a new one", branch)
	case spec.Create:
		args := []string{"worktree", "add", "-b", branch, dir}
		if base != "" {
			args = append(args, base)
		}
		if _, err := gitOut(ctx, repo, args...); err != nil {
			return Worktree{}, err
		}
		return Worktree{Path: dir, Branch: branch}, nil
	case local:
		if _, err := gitOut(ctx, repo, "worktree", "add", dir, branch); err != nil {
			return Worktree{}, err
		}
		return Worktree{Path: dir, Branch: branch}, nil
	}
	remote, err := remoteBranch(ctx, repo, branch)
	if err != nil {
		return Worktree{}, err
	}
	if _, err := gitOut(ctx, repo, "worktree", "add", "--track", "-b", branch, dir, remote); err != nil {
		return Worktree{}, err
	}
	return Worktree{Path: dir, Branch: branch, Tracks: remote}, nil
}

// WorktreeDir is where Caprock puts the worktrees it makes, under the
// repository root (store.WorktreeDir; the resolver strips it by name).
const WorktreeDir = ".caprock-worktrees"

// checkBranchName refuses what git would not take as a branch name, and a
// leading dash that git would take as an option.
func checkBranchName(ctx context.Context, repoDir, branch string) error {
	if branch == "" {
		return errors.New("name the branch")
	}
	if strings.HasPrefix(branch, "-") {
		return fmt.Errorf("%q is not a valid branch name", branch)
	}
	if _, err := gitOut(ctx, repoDir, "check-ref-format", "--branch", branch); err != nil {
		return fmt.Errorf("%q is not a valid branch name", branch)
	}
	return nil
}

// remoteBranch finds the one remote that has branch, as `<remote>/<branch>`.
func remoteBranch(ctx context.Context, repo, branch string) (string, error) {
	out, err := gitOut(ctx, repo, "for-each-ref", "--format=%(refname:short)", "refs/remotes/*/"+branch)
	if err != nil {
		return "", err
	}
	var found []string
	for _, l := range strings.Split(strings.TrimSpace(out), "\n") {
		if l = strings.TrimSpace(l); l != "" {
			found = append(found, l)
		}
	}
	switch len(found) {
	case 0:
		return "", fmt.Errorf("no branch %s here or on a remote; create it to start one", branch)
	case 1:
		return found[0], nil
	default:
		return "", fmt.Errorf("branch %s is on more than one remote (%s); check it out by hand", branch, strings.Join(found, ", "))
	}
}

// ensureExcluded keeps the worktrees directory out of the repository's own
// status: a checkout inside the tree is otherwise an untracked directory, and
// every project with a worktree would read as changed. Written to
// .git/info/exclude, the repository's local ignore file, never to a tracked
// .gitignore. Best effort.
func ensureExcluded(ctx context.Context, repo string) {
	p, err := gitOut(ctx, repo, "rev-parse", "--git-path", "info/exclude")
	if err != nil {
		return
	}
	path := strings.TrimSpace(p)
	if !filepath.IsAbs(path) {
		path = filepath.Join(repo, path)
	}
	line := "/" + WorktreeDir + "/"
	b, _ := os.ReadFile(path)
	for _, l := range strings.Split(string(b), "\n") {
		if strings.TrimSpace(l) == line {
			return
		}
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	if len(b) > 0 && !bytes.HasSuffix(b, []byte("\n")) {
		_, _ = f.WriteString("\n")
	}
	_, _ = f.WriteString(line + "\n")
}

// ErrWorktreeDirty refuses to remove a worktree with changes.
var ErrWorktreeDirty = errors.New("the worktree has uncommitted or untracked changes")

// RemoveWorktree removes a clean worktree Caprock made, and leaves its branch.
//
// Only a worktree under <repo>/.caprock-worktrees is removed: one the user
// made elsewhere is theirs. A worktree with any change — modified, staged or
// untracked — is refused with ErrWorktreeDirty, checked here and again by
// git itself (no --force), so a race cannot lose work.
func RemoveWorktree(ctx context.Context, repoDir, name string) error {
	if name == "" || strings.ContainsAny(name, `/\:`) || name == "." || name == ".." {
		return fmt.Errorf("%q is not a worktree name", name)
	}
	top, err := gitOut(ctx, repoDir, "rev-parse", "--show-toplevel")
	if err != nil {
		return fmt.Errorf("%s is not a git repository", repoDir)
	}
	dir := filepath.Join(filepath.Clean(strings.TrimSpace(top)), WorktreeDir, name)
	if fi, err := os.Stat(filepath.Join(dir, ".git")); err != nil || fi.IsDir() {
		return fmt.Errorf("%s is not a worktree Caprock made", dir)
	}
	status, err := gitOut(ctx, dir, "--no-optional-locks", "status", "--porcelain")
	if err != nil {
		return err
	}
	if strings.TrimSpace(status) != "" {
		return ErrWorktreeDirty
	}
	_, err = gitOut(ctx, repoDir, "worktree", "remove", dir)
	return err
}
