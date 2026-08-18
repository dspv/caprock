// Package gitdiff produces the live diff for a session's working directory by
// shelling out to git. It never modifies the repository.
package gitdiff

import (
	"bytes"
	"context"
	"errors"
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
}

// ErrNotARepo means cwd is not inside a git work tree (→ HTTP 409).
var ErrNotARepo = errors.New("not a git repository")

// MaxPatchBytes bounds each file's patch in the response.
const MaxPatchBytes = 200 << 10

// Diff returns working-tree changes vs HEAD (staged + unstaged) plus untracked files.
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
	// Untracked files.
	if out, err := git(ctx, cwd, "ls-files", "--others", "--exclude-standard"); err == nil {
		for _, p := range strings.Split(strings.TrimSpace(out), "\n") {
			if p == "" {
				continue
			}
			files[p] = &FileDiff{Path: p, Status: "untracked"}
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
