// Package gitdiff produces the live diff for a session's working directory by
// shelling out to git. It never modifies the repository.
package gitdiff

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// FileDiff is one changed file.
type FileDiff struct {
	Path      string `json:"path"`
	Status    string `json:"status"` // modified | added | deleted | renamed | untracked
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
	Patch     string `json:"patch,omitempty"`
	Binary    bool   `json:"binary,omitempty"`
}

// Result is the diff of a working tree.
type Result struct {
	Root   string     `json:"root"`
	Branch string     `json:"branch"`
	Files  []FileDiff `json:"files"`
	Stat   string     `json:"stat"`
	// Base names what the changes are measured against, so a reader is never
	// left guessing whether a figure covers the branch or only the working
	// tree. Empty means HEAD (the trunk, or a repo with no other branch).
	Base string `json:"base,omitempty"`
	// BaseBranch is the trunk this branch forked from, when one was found.
	BaseBranch string `json:"base_branch,omitempty"`
}

// ErrNotARepo means cwd is not inside a git work tree (→ HTTP 409).
var ErrNotARepo = errors.New("not a git repository")

// MaxPatchBytes bounds each file's patch in the response.
const MaxPatchBytes = 200 << 10

// DefaultBases are the branches a feature branch is measured against, in
// order of preference. The first that exists and is not the current branch
// wins; on the trunk itself none of them apply and the base stays HEAD.
var DefaultBases = []string{"master", "main"}

// Diff returns what this session's branch changed: its own commits since it
// left the trunk, plus everything still uncommitted, plus untracked files.
//
// It used to diff the working tree against HEAD alone, which answers "what
// have I not committed yet" — a different question, and the wrong one for a
// panel titled with the branch name. On a branch whose work was committed,
// every file it changed had already moved into HEAD, so the panel reported
// no changes at all while the session had rewritten twenty files. Measuring
// from the merge base makes the branch the unit, which is what the reader is
// looking at.
func Diff(ctx context.Context, cwd string) (*Result, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	root, err := git(ctx, cwd, "rev-parse", "--show-toplevel")
	if err != nil {
		return nil, ErrNotARepo
	}
	res := &Result{Root: strings.TrimSpace(root)}
	// Run everything from the repo root so paths (and untracked listing) are repo-relative.
	cwd = res.Root
	if b, err := git(ctx, cwd, "rev-parse", "--abbrev-ref", "HEAD"); err == nil {
		res.Branch = strings.TrimSpace(b)
	}
	base := "HEAD"
	if _, err := git(ctx, cwd, "rev-parse", "--verify", "HEAD"); err != nil {
		base = "" // unborn branch: diff against the empty index
	} else if mb, trunk := mergeBase(ctx, cwd, res.Branch); mb != "" {
		// The fork point, not the trunk's tip: diffing against a moving
		// master would attribute everyone else's commits to this session the
		// moment the trunk advanced.
		base = mb
		res.BaseBranch = trunk
		res.Base = "since " + trunk
	}
	// numstat for counts.
	args := []string{"diff", "--numstat", "-M"}
	if base != "" {
		args = append(args, base)
	}
	numstat, _ := git(ctx, cwd, args...)
	files := map[string]*FileDiff{}
	var order []string
	for _, line := range strings.Split(strings.TrimSpace(numstat), "\n") {
		parts := strings.SplitN(line, "\t", 3)
		if len(parts) != 3 {
			continue
		}
		fd := &FileDiff{Path: parts[2], Status: "modified"}
		if parts[0] == "-" {
			fd.Binary = true
		} else {
			fd.Additions, _ = strconv.Atoi(parts[0])
			fd.Deletions, _ = strconv.Atoi(parts[1])
		}
		if strings.Contains(fd.Path, " => ") {
			fd.Status = "renamed"
		}
		files[fd.Path] = fd
		order = append(order, fd.Path)
	}
	// name-status refines added/deleted.
	args = []string{"diff", "--name-status", "-M"}
	if base != "" {
		args = append(args, base)
	}
	if ns, err := git(ctx, cwd, args...); err == nil {
		for _, line := range strings.Split(strings.TrimSpace(ns), "\n") {
			parts := strings.Split(line, "\t")
			if len(parts) < 2 {
				continue
			}
			path := parts[len(parts)-1]
			fd := files[path]
			if fd == nil {
				continue
			}
			switch parts[0][0] {
			case 'A':
				fd.Status = "added"
			case 'D':
				fd.Status = "deleted"
			case 'R':
				fd.Status = "renamed"
			}
		}
	}
	// Full patch, split per file.
	args = []string{"diff", "-M", "--no-color", "--no-ext-diff"}
	if base != "" {
		args = append(args, base)
	}
	if patch, err := git(ctx, cwd, args...); err == nil {
		for path, p := range splitPatch(patch) {
			if fd := files[path]; fd != nil {
				fd.Patch = capPatch(p)
			}
		}
	}
	// Untracked files. git will not diff them, so we ask it to diff each one
	// against nothing — `--no-index /dev/null <path>` produces exactly the
	// all-additions patch a new file deserves. Without this the panel said
	// "untracked — no diff against HEAD", which is true and useless: a new
	// file's content *is* its change, and answering a question the reader did
	// not ask reads as a broken panel.
	if out, err := git(ctx, cwd, "ls-files", "--others", "--exclude-standard"); err == nil {
		for _, p := range strings.Split(strings.TrimSpace(out), "\n") {
			if p == "" {
				continue
			}
			fd := &FileDiff{Path: p, Status: "untracked"}
			// --no-index exits 1 when the files differ, which is always here,
			// so the error is expected and only the output matters.
			patch := gitOut(ctx, cwd, "diff", "--no-color", "--no-ext-diff", "--no-index", os.DevNull, p)
			if patch != "" {
				fd.Patch = capPatch(rewriteNoIndexHeader(patch, p))
				fd.Additions, fd.Binary = countAdded(patch)
			}
			files[p] = fd
			order = append(order, p)
		}
	}
	for _, p := range order {
		res.Files = append(res.Files, *files[p])
	}
	if res.Files == nil {
		res.Files = []FileDiff{}
	}
	args = []string{"diff", "--stat", "-M"}
	if base != "" {
		args = append(args, base)
	}
	if st, err := git(ctx, cwd, args...); err == nil {
		res.Stat = strings.TrimSpace(st)
	}
	return res, nil
}

func git(ctx context.Context, cwd string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", cwd}, args...)...)
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := cmd.Run(); err != nil {
		return "", errors.New(strings.TrimSpace(errb.String()))
	}
	return out.String(), nil
}

// gitOut runs git and keeps stdout even when the exit status is non-zero.
// `diff --no-index` exits 1 whenever the two inputs differ, which for an
// untracked file is always — treating that as failure threw the patch away
// and left every new file rendering as empty.
func gitOut(ctx context.Context, cwd string, args ...string) string {
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", cwd}, args...)...)
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, nil
	_ = cmd.Run()
	return out.String()
}

// splitPatch splits a unified diff into per-file chunks keyed by the b/ path.
func splitPatch(patch string) map[string]string {
	out := map[string]string{}
	chunks := strings.Split(patch, "\ndiff --git ")
	for i, c := range chunks {
		if i > 0 {
			c = "diff --git " + c
		}
		c = strings.TrimSpace(c)
		if c == "" {
			continue
		}
		first, _, _ := strings.Cut(c, "\n")
		// "diff --git a/x b/x" → take the b/ side (rename-safe: last " b/").
		if idx := strings.LastIndex(first, " b/"); idx >= 0 {
			out[first[idx+3:]] = c + "\n"
		}
	}
	return out
}

func capPatch(p string) string {
	if len(p) <= MaxPatchBytes {
		return p
	}
	return p[:MaxPatchBytes] + "\n… [patch truncated]\n"
}

// mergeBase finds where `branch` left the trunk, so a session's diff covers
// its own commits and not the trunk's. Returns "" when there is no other
// branch to measure against — a repo with only master, or master itself —
// and the caller keeps HEAD.
func mergeBase(ctx context.Context, cwd, branch string) (rev, trunk string) {
	if branch == "" || branch == "HEAD" { // detached: nothing to fork from
		return "", ""
	}
	for _, t := range DefaultBases {
		if t == branch {
			return "", "" // on the trunk: its own commits are not "changes"
		}
		if _, err := git(ctx, cwd, "rev-parse", "--verify", t); err != nil {
			continue
		}
		mb, err := git(ctx, cwd, "merge-base", t, "HEAD")
		if err != nil {
			continue
		}
		if mb = strings.TrimSpace(mb); mb != "" {
			return mb, t
		}
	}
	return "", ""
}

// rewriteNoIndexHeader makes a --no-index patch look like an ordinary one.
// git writes the null device as the source path (`--- /dev/null`, and on the
// `diff --git` line), which is correct but shows the reader a device name
// where a filename belongs.
func rewriteNoIndexHeader(patch, path string) string {
	patch = strings.ReplaceAll(patch, "a/"+os.DevNull, "a/"+path)
	patch = strings.ReplaceAll(patch, os.DevNull+" b/"+path, "a/"+path+" b/"+path)
	return patch
}

// countAdded reports the added-line count of an all-additions patch, and
// whether git called it binary.
func countAdded(patch string) (int, bool) {
	if strings.Contains(patch, "Binary files ") || strings.Contains(patch, "GIT binary patch") {
		return 0, true
	}
	n := 0
	for _, line := range strings.Split(patch, "\n") {
		if strings.HasPrefix(line, "+") && !strings.HasPrefix(line, "+++") {
			n++
		}
	}
	return n, false
}
