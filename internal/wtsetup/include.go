// Package wtsetup makes a new worktree ready to run (ADR-050): it copies the
// git-ignored files the repository's .worktreeinclude names from the main
// checkout into the new worktree, and runs the project's setup command in the
// agent's own terminal before the agent starts.
//
// .worktreeinclude has Claude Code's semantics: gitignore patterns at the
// repository root, and a file is copied only when it matches one AND git
// ignores it — tracked files are already in the worktree, and an untracked
// file nobody ignores is work in progress, not configuration.
package wtsetup

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/dspv/caprock/internal/hidewin"
)

// IncludeFile is the file at the repository root that names what to copy.
const IncludeFile = ".worktreeinclude"

// Limits on one copy. A .worktreeinclude is for .env files and local
// configuration; a pattern that sweeps up a dependency tree stops here
// rather than filling the disk or holding up the agent's start.
const (
	MaxFiles = 5000
	MaxBytes = 256 << 20
)

// maxBytes is MaxBytes; a variable so a test can lower it.
var maxBytes int64 = MaxBytes

// Copied reports what CopyIncluded did.
type Copied struct {
	// Files and Bytes were copied.
	Files int
	Bytes int64
	// Names are the first few copied paths, slash-separated, for a log line.
	Names []string
	// Skipped counts files left alone: already in the worktree, a symlink
	// pointing outside the repository, or not a regular file.
	Skipped int
	// OverLimit is true when MaxFiles or MaxBytes stopped the copy early.
	OverLimit bool
}

// Summary is Copied as one line, empty when nothing happened.
func (c Copied) Summary() string {
	if c.Files == 0 && c.Skipped == 0 && !c.OverLimit {
		return ""
	}
	s := fmt.Sprintf("copied %d %s from %s", c.Files, plural(c.Files, "file", "files"), IncludeFile)
	if len(c.Names) > 0 {
		s += " (" + strings.Join(c.Names, ", ")
		if c.Files > len(c.Names) {
			s += ", …"
		}
		s += ")"
	}
	if c.Skipped > 0 {
		s += fmt.Sprintf("; skipped %d", c.Skipped)
	}
	if c.OverLimit {
		s += fmt.Sprintf("; stopped at the limit of %d files or %d MB", MaxFiles, MaxBytes>>20)
	}
	return s
}

func plural(n int, one, many string) string {
	if n == 1 {
		return one
	}
	return many
}

const namesShown = 4

// CopyIncluded copies into dst every file under src that src's
// .worktreeinclude names and git ignores. src is the checkout the worktree
// was made from (its top level); dst is the new worktree.
//
// It never writes outside dst, never overwrites a file that is already
// there, and copies a symlink only when it is relative and points inside src.
// No .worktreeinclude is not an error: nothing is copied.
func CopyIncluded(ctx context.Context, src, dst string) (Copied, error) {
	var out Copied
	include := filepath.Join(src, IncludeFile)
	if !isFile(include) {
		return out, nil
	}
	candidates, err := gitList(ctx, src, "ls-files", "-z", "--others", "--ignored", "--exclude-from="+include)
	if err != nil {
		return out, fmt.Errorf("read %s: %w", IncludeFile, err)
	}
	if len(candidates) == 0 {
		return out, nil
	}
	ignored, err := checkIgnored(ctx, src, candidates)
	if err != nil {
		return out, err
	}
	realSrc, err := filepath.EvalSymlinks(src)
	if err != nil {
		return out, err
	}
	realDst, err := filepath.EvalSymlinks(dst)
	if err != nil {
		return out, err
	}
	for _, rel := range ignored {
		if err := ctx.Err(); err != nil {
			return out, err
		}
		if out.Files >= MaxFiles {
			out.OverLimit = true
			break
		}
		switch copyOne(realSrc, realDst, rel, &out) {
		case copied:
			if len(out.Names) < namesShown {
				out.Names = append(out.Names, rel)
			}
		case skipped:
			out.Skipped++
		case overLimit:
			out.OverLimit = true
		}
	}
	return out, nil
}

// isFile reports whether path is a regular file; a missing one is not.
func isFile(path string) bool {
	fi, err := os.Stat(path)
	return err == nil && fi.Mode().IsRegular()
}

type verdict int

const (
	copied verdict = iota
	skipped
	overLimit
)

// copyOne copies one slash-separated path from src to dst, both resolved.
func copyOne(src, dst, rel string, out *Copied) verdict {
	local := filepath.FromSlash(rel)
	if local == "" || filepath.IsAbs(local) || !within(".", local) {
		return skipped
	}
	from := filepath.Join(src, local)
	to := filepath.Join(dst, local)
	if !within(src, from) || !within(dst, to) {
		return skipped
	}
	fi, err := os.Lstat(from)
	if err != nil {
		return skipped
	}
	if _, err := os.Lstat(to); err == nil {
		// The worktree has its own: a tracked file, or one made since.
		return skipped
	}
	if !parentInside(dst, to) {
		return skipped
	}
	switch {
	case fi.Mode()&os.ModeSymlink != 0:
		link, err := os.Readlink(from)
		if err != nil || filepath.IsAbs(link) {
			return skipped
		}
		target, err := filepath.EvalSymlinks(from)
		if err != nil || !within(src, target) {
			return skipped
		}
		if os.Symlink(link, to) != nil {
			return skipped
		}
		out.Files++
		return copied
	case fi.Mode().IsRegular():
		if out.Bytes+fi.Size() > maxBytes {
			return overLimit
		}
		n, err := copyFile(from, to, fi.Mode().Perm())
		if err != nil {
			_ = os.Remove(to)
			return skipped
		}
		out.Files++
		out.Bytes += n
		return copied
	}
	return skipped
}

// parentInside makes to's directory and checks that it, symlinks resolved,
// is still inside dst: a tracked symlinked directory in the worktree must not
// carry a copy out of it.
func parentInside(dst, to string) bool {
	dir := filepath.Dir(to)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return false
	}
	real, err := filepath.EvalSymlinks(dir)
	return err == nil && within(dst, real)
}

func copyFile(from, to string, perm os.FileMode) (int64, error) {
	in, err := os.Open(from)
	if err != nil {
		return 0, err
	}
	defer in.Close()
	f, err := os.OpenFile(to, os.O_WRONLY|os.O_CREATE|os.O_EXCL, perm|0o200)
	if err != nil {
		return 0, err
	}
	n, err := io.Copy(f, in)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	return n, err
}

// within reports whether path is base or below it (both cleaned, same form).
func within(base, path string) bool {
	rel, err := filepath.Rel(base, path)
	if err != nil {
		return false
	}
	return rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)))
}

// checkIgnored keeps the paths git's own ignore rules match.
func checkIgnored(ctx context.Context, dir string, paths []string) ([]string, error) {
	var in bytes.Buffer
	for _, p := range paths {
		in.WriteString(p)
		in.WriteByte(0)
	}
	cmd := hidewin.CommandContext(ctx, "git", "-C", dir, "check-ignore", "-z", "--stdin")
	cmd.Stdin = &in
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		// Exit status 1 is "none of these is ignored", not a failure.
		var ee *exec.ExitError
		if errors.As(err, &ee) && ee.ExitCode() == 1 {
			return nil, nil
		}
		return nil, fmt.Errorf("git check-ignore: %s", strings.TrimSpace(stderr.String()))
	}
	return splitZ(stdout.Bytes()), nil
}

func gitList(ctx context.Context, dir string, args ...string) ([]string, error) {
	cmd := hidewin.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("git %s: %s", args[0], strings.TrimSpace(stderr.String()))
	}
	return splitZ(stdout.Bytes()), nil
}

func splitZ(b []byte) []string {
	var out []string
	for _, p := range bytes.Split(b, []byte{0}) {
		if len(p) > 0 {
			out = append(out, string(p))
		}
	}
	return out
}
