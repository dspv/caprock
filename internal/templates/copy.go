package templates

import (
	"archive/tar"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/dspv/caprock/internal/hidewin"
	"github.com/dspv/caprock/internal/wtsetup"
)

// The local copy's limits, ADR-050's: past either the copy stops and the
// project is not made.
const (
	MaxCopyFiles = wtsetup.MaxFiles
	MaxCopyBytes = wtsetup.MaxBytes
)

// copyFiles and copyBytes are the limits a copy runs under; tests lower them.
var (
	copyFiles       = MaxCopyFiles
	copyBytes int64 = MaxCopyBytes
)

// errTooBig is a template past the copy's limits.
var errTooBig = fmt.Errorf("the template has more than %d files or %d MB; copy it by hand", MaxCopyFiles, MaxCopyBytes>>20)

// copier writes a template's files into a new project's folder and never
// outside it: no path leaves it, nothing is written through a link, and a
// link is kept only when it is relative and still lands inside once every
// file is in place.
type copier struct {
	root    string // the project folder, links resolved
	files   int
	bytes   int64
	skipped int
	links   []string
}

func newCopier(dest string) (*copier, error) {
	root, err := filepath.EvalSymlinks(dest)
	if err != nil {
		return nil, err
	}
	return &copier{root: root}, nil
}

// target is rel's place in the project, or "" when rel may not be written:
// it leaves the folder, goes into .git, or a folder on its way is a link.
func (c *copier) target(rel string) string {
	rel = strings.TrimSuffix(strings.TrimPrefix(rel, "./"), "/")
	if rel == "" || rel == "." {
		return ""
	}
	local := filepath.FromSlash(rel)
	if !filepath.IsLocal(local) {
		return ""
	}
	for _, seg := range strings.Split(filepath.ToSlash(local), "/") {
		if strings.EqualFold(seg, ".git") {
			return ""
		}
	}
	segs := strings.Split(filepath.ToSlash(local), "/")
	dir := c.root
	for _, seg := range segs[:len(segs)-1] {
		if !mkdirNoLink(filepath.Join(dir, seg)) {
			return ""
		}
		dir = filepath.Join(dir, seg)
	}
	return filepath.Join(dir, segs[len(segs)-1])
}

// mkdirNoLink makes the folder p when it is missing and reports whether p
// is now a real folder: a link, even to a folder, is not one.
func mkdirNoLink(p string) bool {
	fi, err := os.Lstat(p)
	if errors.Is(err, fs.ErrNotExist) {
		return os.Mkdir(p, 0o755) == nil
	}
	return err == nil && fi.IsDir() && fi.Mode()&fs.ModeSymlink == 0
}

func (c *copier) dir(rel string) {
	if p := c.target(rel); p == "" || !mkdirNoLink(p) {
		c.skipped++
	}
}

func (c *copier) file(rel string, mode fs.FileMode, r io.Reader) error {
	p := c.target(rel)
	if p == "" {
		c.skipped++
		return nil
	}
	c.files++
	if c.files > copyFiles {
		return errTooBig
	}
	perm := fs.FileMode(0o644)
	if mode&0o111 != 0 {
		perm = 0o755
	}
	f, err := os.OpenFile(p, os.O_WRONLY|os.O_CREATE|os.O_EXCL, perm)
	if err != nil {
		c.skipped++
		return nil //nolint:nilerr // a name the OS refuses is skipped and counted
	}
	n, err := io.Copy(f, io.LimitReader(r, copyBytes-c.bytes+1))
	c.bytes += n
	cerr := f.Close()
	if c.bytes > copyBytes {
		return errTooBig
	}
	if err != nil {
		return err
	}
	return cerr
}

func (c *copier) link(rel, to string) {
	p := c.target(rel)
	if p == "" || to == "" || filepath.IsAbs(to) || strings.HasPrefix(to, "/") || strings.HasPrefix(to, `\`) || driveLetter.MatchString(to) {
		c.skipped++
		return
	}
	lexical := filepath.Join(filepath.Dir(p), filepath.FromSlash(to))
	if back, err := filepath.Rel(c.root, lexical); err != nil || (back != "." && !filepath.IsLocal(back)) {
		c.skipped++
		return
	}
	if err := os.Symlink(filepath.FromSlash(to), p); err != nil {
		c.skipped++ // Windows without the right to make links
		return
	}
	c.links = append(c.links, p)
}

// finish takes out every link that, with all files in place, does not
// resolve inside the folder.
func (c *copier) finish() {
	for _, l := range c.links {
		real, err := filepath.EvalSymlinks(l)
		if err == nil {
			if back, rerr := filepath.Rel(c.root, real); rerr == nil && (back == "." || filepath.IsLocal(back)) {
				continue
			}
		}
		_ = os.Remove(l)
		c.skipped++
	}
}

// copyFolder copies a folder that is not a repository, leaving out .git and
// node_modules wherever they are.
func copyFolder(src string, c *copier) error {
	err := filepath.WalkDir(src, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			if path == src {
				return err
			}
			c.skipped++
			return nil
		}
		if path == src {
			return nil
		}
		rel, rerr := filepath.Rel(src, path)
		if rerr != nil {
			return rerr
		}
		rel = filepath.ToSlash(rel)
		switch t := d.Type(); {
		case d.IsDir():
			if n := d.Name(); n == ".git" || n == "node_modules" {
				return filepath.SkipDir
			}
			c.dir(rel)
		case t&fs.ModeSymlink != 0:
			to, lerr := os.Readlink(path)
			if lerr != nil {
				c.skipped++
				return nil //nolint:nilerr // skipped and counted
			}
			c.link(rel, filepath.ToSlash(to))
		case t.IsRegular():
			if d.Name() == ".git" { // a worktree's or submodule's pointer file
				return nil
			}
			info, ierr := d.Info()
			if ierr != nil {
				c.skipped++
				return nil //nolint:nilerr // skipped and counted
			}
			f, oerr := os.Open(path)
			if oerr != nil {
				c.skipped++
				return nil //nolint:nilerr // skipped and counted
			}
			ferr := c.file(rel, info.Mode(), f)
			_ = f.Close()
			return ferr
		default:
			c.skipped++ // a FIFO, a socket, a device
		}
		return nil
	})
	c.finish()
	return err
}

// copyArchive copies a repository's last commit: `git archive --format=tar
// HEAD`, unpacked here.
func (s *Service) copyArchive(ctx context.Context, src string, c *copier) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	cmd := hidewin.CommandContext(ctx, "git", "-C", src, "archive", "--format=tar", "HEAD") //nolint:gosec // fixed arguments; src checked
	cmd.Env = s.env()
	cmd.WaitDelay = 5 * time.Second
	var errb strings.Builder
	cmd.Stderr = &errb
	out, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	rerr := untar(out, c)
	if rerr != nil {
		cancel() // stop git; what it would still send is not wanted
	}
	_, _ = io.Copy(io.Discard, out)
	werr := cmd.Wait()
	c.finish()
	if rerr != nil {
		return rerr
	}
	if werr != nil {
		return fmt.Errorf("git archive in %s: %s", src, firstLines(errb.String(), werr))
	}
	return nil
}

func untar(r io.Reader, c *copier) error {
	tr := tar.NewReader(r)
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		switch h.Typeflag {
		case tar.TypeDir:
			c.dir(h.Name)
		case tar.TypeReg:
			if err := c.file(h.Name, fs.FileMode(h.Mode), tr); err != nil {
				return err
			}
		case tar.TypeSymlink:
			c.link(h.Name, h.Linkname)
		case tar.TypeXGlobalHeader:
			// git's own header: the commit id.
		default:
			c.skipped++
		}
	}
}
