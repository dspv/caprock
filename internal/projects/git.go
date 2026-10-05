package projects

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// GitStatus is what git says about a project's working tree, as the sidebar
// shows it.
type GitStatus struct {
	Branch        string `json:"branch"`             // "" when detached
	Detached      bool   `json:"detached,omitempty"` // HEAD is not on a branch
	Dirty         bool   `json:"dirty"`
	Changed       int    `json:"changed"` // files modified, staged, conflicted or untracked
	Ahead         int    `json:"ahead"`
	Behind        int    `json:"behind"`
	Upstream      string `json:"upstream,omitempty"`
	DefaultBranch string `json:"default_branch,omitempty"`
	RemoteURL     string `json:"remote_url,omitempty"`
	// Error is why the last refresh failed (git missing, a timeout, a broken
	// repository), with git's own words; the other fields are then the last
	// good answer, or zero.
	Error string `json:"error,omitempty"`
	// At is when git last answered, unix ms; 0 while the first answer is
	// still on its way.
	At int64 `json:"at"`
}

// WorktreeView is one linked worktree of a project.
type WorktreeView struct {
	Name    string `json:"name"` // git's name for it (.git/worktrees/<name>)
	Path    string `json:"path"`
	Branch  string `json:"branch,omitempty"`
	Head    string `json:"head,omitempty"` // the commit, when detached
	Caprock bool   `json:"caprock"`        // made by Caprock, so removable from here
	Locked  bool   `json:"locked,omitempty"`
	Missing bool   `json:"missing,omitempty"` // its folder is gone (git calls it prunable)
	Dirty   bool   `json:"dirty"`
	Changed int    `json:"changed"`
	Error   string `json:"error,omitempty"`
}

// gitDirs are where a repository keeps its state: the git dir of the
// checkout (HEAD, index) and the common dir (refs, config, worktrees), which
// differ only for a linked worktree or a submodule.
type gitDirs struct {
	git    string
	common string
}

// findGitDirs locates root's git dirs from files alone, without running git.
func findGitDirs(root string) (gitDirs, bool) {
	dotGit := filepath.Join(root, ".git")
	st, err := os.Stat(dotGit)
	if err != nil {
		return gitDirs{}, false
	}
	gd := dotGit
	if !st.IsDir() {
		b, err := os.ReadFile(dotGit)
		if err != nil {
			return gitDirs{}, false
		}
		line := strings.TrimSpace(string(b))
		p, ok := strings.CutPrefix(line, "gitdir:")
		if !ok {
			return gitDirs{}, false
		}
		p = strings.TrimSpace(p)
		if !filepath.IsAbs(p) {
			p = filepath.Join(root, p)
		}
		gd = filepath.Clean(p)
	}
	common := gd
	if b, err := os.ReadFile(filepath.Join(gd, "commondir")); err == nil {
		c := strings.TrimSpace(string(b))
		if !filepath.IsAbs(c) {
			c = filepath.Join(gd, c)
		}
		common = filepath.Clean(c)
	}
	return gitDirs{git: gd, common: common}, true
}

// parseStatus reads `git status --porcelain=v2 --branch`.
func parseStatus(out []byte) GitStatus {
	var g GitStatus
	sc := bufio.NewScanner(bytes.NewReader(out))
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		line := sc.Text()
		if line == "" {
			continue
		}
		rest, header := strings.CutPrefix(line, "# ")
		if !header {
			g.Changed++
			continue
		}
		key, val, _ := strings.Cut(rest, " ")
		switch key {
		case "branch.head":
			if val == "(detached)" {
				g.Detached = true
			} else {
				g.Branch = val
			}
		case "branch.upstream":
			g.Upstream = val
		case "branch.ab":
			a, b, _ := strings.Cut(val, " ")
			g.Ahead, _ = strconv.Atoi(strings.TrimPrefix(a, "+"))
			g.Behind, _ = strconv.Atoi(strings.TrimPrefix(b, "-"))
		}
	}
	g.Dirty = g.Changed > 0
	return g
}

// readRemoteURL reads origin's url (else the first remote's) from the
// repository's config file.
func readRemoteURL(common string) string {
	b, err := os.ReadFile(filepath.Join(common, "config"))
	if err != nil {
		return ""
	}
	section, first, origin := "", "", ""
	for _, raw := range strings.Split(string(b), "\n") {
		line := strings.TrimSpace(raw)
		if strings.HasPrefix(line, "[") {
			section = strings.Trim(line, "[] ")
			continue
		}
		if !strings.HasPrefix(section, "remote ") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok || strings.TrimSpace(k) != "url" {
			continue
		}
		v = strings.TrimSpace(v)
		if first == "" {
			first = v
		}
		if section == `remote "origin"` && origin == "" {
			origin = v
		}
	}
	if origin != "" {
		return origin
	}
	return first
}

// readDefaultBranch is the branch origin/HEAD points at, else main or master
// when the repository has one of them, else "".
func readDefaultBranch(common string) string {
	if b, err := os.ReadFile(filepath.Join(common, "refs", "remotes", "origin", "HEAD")); err == nil {
		if ref, ok := strings.CutPrefix(strings.TrimSpace(string(b)), "ref: refs/remotes/origin/"); ok {
			return ref
		}
	}
	packed, _ := os.ReadFile(filepath.Join(common, "packed-refs"))
	for _, b := range []string{"main", "master"} {
		if _, err := os.Stat(filepath.Join(common, "refs", "heads", b)); err == nil {
			return b
		}
		if bytes.Contains(packed, []byte(" refs/heads/"+b+"\n")) {
			return b
		}
	}
	return ""
}

// readWorktrees lists a repository's linked worktrees from
// <common>/worktrees, without running git. caprockDir is where Caprock makes
// them (<root>/.caprock-worktrees).
func readWorktrees(common, caprockDir string) []WorktreeView {
	ents, err := os.ReadDir(filepath.Join(common, "worktrees"))
	if err != nil {
		return nil
	}
	var out []WorktreeView
	for _, e := range ents {
		if !e.IsDir() {
			continue
		}
		dir := filepath.Join(common, "worktrees", e.Name())
		b, err := os.ReadFile(filepath.Join(dir, "gitdir"))
		if err != nil {
			continue
		}
		dotGit := strings.TrimSpace(string(b))
		if !filepath.IsAbs(dotGit) {
			dotGit = filepath.Join(dir, dotGit)
		}
		path := filepath.Dir(filepath.Clean(dotGit))
		w := WorktreeView{Name: e.Name(), Path: path}
		if head, err := os.ReadFile(filepath.Join(dir, "HEAD")); err == nil {
			h := strings.TrimSpace(string(head))
			if ref, ok := strings.CutPrefix(h, "ref: refs/heads/"); ok {
				w.Branch = ref
			} else {
				w.Head = h
			}
		}
		if _, err := os.Stat(filepath.Join(dir, "locked")); err == nil {
			w.Locked = true
		}
		if _, err := os.Stat(path); err != nil {
			w.Missing = true
		}
		w.Caprock = filepath.Dir(path) == filepath.Clean(caprockDir)
		out = append(out, w)
	}
	return out
}

// gitBin is the git that runs; a test points it at one that hangs.
var gitBin = "git"

// errGitTimeout is a git that did not answer within the timeout and was
// killed.
var errGitTimeout = errors.New("git did not answer in time and was stopped")

// runGit runs one git command in dir under timeout and returns its stdout;
// on failure the error carries git's own stderr.
func runGit(ctx context.Context, timeout time.Duration, dir string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, gitBin, append([]string{"--no-optional-locks", "-C", dir}, args...)...) //nolint:gosec // fixed git subcommands
	cmd.Env = append(os.Environ(), "GIT_OPTIONAL_LOCKS=0", "GIT_TERMINAL_PROMPT=0", "LC_ALL=C")
	cmd.WaitDelay = time.Second
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	err := cmd.Run()
	if ctx.Err() == context.DeadlineExceeded {
		return nil, fmt.Errorf("%w (%s, after %s)", errGitTimeout, strings.Join(args, " "), timeout)
	}
	if err != nil {
		msg := strings.TrimSpace(errb.String())
		if msg == "" {
			msg = err.Error()
		}
		return nil, errors.New(msg)
	}
	return out.Bytes(), nil
}
