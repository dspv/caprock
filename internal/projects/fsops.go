package projects

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/dspv/caprock/internal/tcc"
	"github.com/dspv/caprock/internal/trash"
)

// The Files tab (ADR-089, .ai/03-contracts.md § Files tab): list a folder of
// a project's checkout or one of its worktrees, compare a folder across two
// of them, diff one file across them, and copy, move, rename, make a folder
// and send to the Trash. Every path is relative to a root Caprock already
// tracks — the project's folder or a linked worktree's — and is resolved
// with every symlink followed before use; whatever lands outside that
// root's own real location is refused. A write acts on the named item
// itself (a link, not its target). Nothing is ever deleted: removal is a
// move to the operating system's Trash (internal/trash).

const (
	// MaxDirEntries caps one folder listing.
	MaxDirEntries = 5000
	// MaxDiffBytes is the most of each side a file diff reads.
	MaxDiffBytes = 512 << 10
	// maxDiffLines caps the patch a diff sends.
	maxDiffLines = 4000
	// maxCompareRead is the most a folder comparison reads in file
	// contents, both sides together, before it answers partial.
	maxCompareRead = 64 << 20
	// maxCopyEntries and maxCopyBytes cap one copy; past them it is refused
	// before anything is written.
	maxCopyEntries = 50000
	maxCopyBytes   = 4 << 30
)

// FsEntry is one item of a folder.
type FsEntry struct {
	Name string `json:"name"`
	// Dir is a folder, or a link to one.
	Dir  bool  `json:"dir,omitempty"`
	Link bool  `json:"link,omitempty"`
	Size int64 `json:"size"`
	// Mtime is the modification time in Unix milliseconds.
	Mtime int64 `json:"mtime"`
	// Git is the item's mark in a repository: M modified, A added, D
	// deleted (staged, still on disk), U conflicted, ? untracked, !
	// ignored; on a folder, . when something inside has changed.
	Git string `json:"git,omitempty"`
}

// FsListing is a folder of a root.
type FsListing struct {
	// Path is the folder, relative to the root and in slash form; "" is the
	// root itself.
	Path string `json:"path"`
	// Root is the root's absolute folder on this machine.
	Root      string    `json:"root"`
	Entries   []FsEntry `json:"entries"`
	Truncated bool      `json:"truncated,omitempty"`
	// Git is true when the root is a git checkout; Branch its branch.
	Git    bool   `json:"git"`
	Branch string `json:"branch,omitempty"`
}

// FsCompare is how one folder differs between two roots, by entry name:
// "diff" (both have it, the contents differ), "left" or "right" (only that
// side has it). A name with no state is the same on both sides, or —
// listed in Unknown — not compared (a git-ignored folder).
type FsCompare struct {
	Path    string            `json:"path"`
	States  map[string]string `json:"states"`
	Unknown []string          `json:"unknown,omitempty"`
	// Partial is set when the comparison stopped at its read budget.
	Partial bool `json:"partial,omitempty"`
}

// FsChange is one file a worktree changed since it left its base.
type FsChange struct {
	Path   string `json:"path"`
	Status string `json:"status"` // added, modified, deleted, untracked
}

// FsChanged is what a worktree changed against another's HEAD: the files
// that differ between their merge base and this worktree's folder,
// uncommitted and untracked files included.
type FsChanged struct {
	Base    string     `json:"base"`
	Changes []FsChange `json:"changes"`
}

// FsDiff is one file compared between two roots, left → right.
type FsDiff struct {
	Path  string `json:"path"`
	Left  bool   `json:"left"`  // the left side has the file
	Right bool   `json:"right"` // the right side has it
	Same  bool   `json:"same,omitempty"`
	Patch string `json:"patch"`
	// Additions and Deletions count the patch's + and − lines.
	Additions int  `json:"additions"`
	Deletions int  `json:"deletions"`
	Binary    bool `json:"binary,omitempty"`
	TooLarge  bool `json:"too_large,omitempty"`
	Truncated bool `json:"truncated,omitempty"`
}

// FsResult answers a write: how many items it acted on.
type FsResult struct {
	Done int `json:"done"`
}

// ExistsError is a copy or move whose target names are taken: nothing was
// written; Names lists them so the caller can ask before replacing.
type ExistsError struct{ Names []string }

func (e *ExistsError) Error() string {
	return fmt.Sprintf("%d of them already exist there", len(e.Names))
}

// fsRoot is the real location of a project's folder or of a linked
// worktree's: the boundary for every path below.
func (s *Service) fsRoot(ctx context.Context, id int64, worktree string) (string, error) {
	dir, err := s.folderPath(ctx, id, worktree)
	if err != nil {
		return "", err
	}
	if err := tcc.Check(dir); err != nil {
		return "", err
	}
	real, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return "", ErrNoFile
	}
	return real, nil
}

// fsDir is a folder rel ("" for the root) under root, resolved inside it.
func fsDir(root, rel string) (string, error) {
	if rel == "" {
		return root, nil
	}
	if err := checkRelPath(rel); err != nil {
		return "", err
	}
	real, err := resolveInside(root, rel)
	if err != nil {
		return "", err
	}
	fi, err := os.Stat(real)
	if err != nil {
		return "", ErrNoFile
	}
	if !fi.IsDir() {
		return "", changeErr(KindInvalid, "%s is not a folder", rel)
	}
	return real, nil
}

// fsItem is the item rel names under root, its final component not
// followed: the folder holding it is resolved inside root, and the item is
// that folder joined with its name. It must exist.
func fsItem(root, rel string) (string, error) {
	if err := checkRelPath(rel); err != nil {
		return "", err
	}
	parent := path.Dir(rel)
	if parent == "." {
		parent = ""
	}
	dir, err := fsDir(root, parent)
	if err != nil {
		return "", err
	}
	abs := filepath.Join(dir, path.Base(rel))
	if _, err := os.Lstat(abs); err != nil {
		return "", ErrNoFile
	}
	return abs, nil
}

// checkName is a new item's name: one path element, portable to every
// platform Caprock runs on (Windows' reserved characters and trailing dot
// or space refused everywhere, so a name made here works in a clone there).
func checkName(name string) error {
	switch {
	case name == "" || name == "." || name == "..":
		return changeErr(KindInvalid, "a name is needed")
	case len(name) > 255:
		return changeErr(KindInvalid, "that name is too long")
	case strings.ContainsAny(name, "/\\<>:\"|?*\x00"):
		return changeErr(KindInvalid, "a name cannot hold / \\ < > : \" | ? or *")
	case strings.HasSuffix(name, ".") || strings.HasSuffix(name, " "):
		return changeErr(KindInvalid, "a name cannot end in a dot or a space")
	}
	for _, r := range name {
		if r < 0x20 {
			return changeErr(KindInvalid, "a name cannot hold control characters")
		}
	}
	return nil
}

// guardItem refuses a write on what would break a checkout: the root, git's
// own folder, and a folder that is itself a repository or worktree (it has
// a .git) — removing a worktree is Clean up copies' job.
func guardItem(rel, abs string) error {
	first, _, _ := strings.Cut(rel, "/")
	if rel == "" || strings.EqualFold(first, ".git") {
		return changeErr(KindInvalid, "%s is git's own; Files leaves it alone", rel)
	}
	if fi, err := os.Lstat(abs); err == nil && fi.IsDir() {
		if _, err := os.Lstat(filepath.Join(abs, ".git")); err == nil {
			return changeErr(KindInvalid, "%s is a repository or a worktree; remove a worktree from Clean up copies", rel)
		}
	}
	return nil
}

// inside reports whether p is base or below it.
func inside(base, p string) bool {
	r, err := filepath.Rel(base, p)
	return err == nil && filepath.IsLocal(r)
}

// ListDir lists a folder of a root, folders first, then by name.
func (s *Service) ListDir(ctx context.Context, id int64, worktree, rel string) (FsListing, error) {
	root, err := s.fsRoot(ctx, id, worktree)
	if err != nil {
		return FsListing{}, err
	}
	dir, err := fsDir(root, rel)
	if err != nil {
		return FsListing{}, err
	}
	des, err := os.ReadDir(dir)
	if err != nil {
		return FsListing{}, changeErr(KindState, "the folder could not be read: %v", err)
	}
	out := FsListing{Path: rel, Root: root, Entries: []FsEntry{}}
	for _, d := range des {
		if len(out.Entries) >= MaxDirEntries {
			out.Truncated = true
			break
		}
		fi, err := d.Info()
		if err != nil {
			continue
		}
		e := FsEntry{Name: d.Name(), Size: fi.Size(), Mtime: fi.ModTime().UnixMilli(), Dir: fi.IsDir()}
		if fi.Mode()&fs.ModeSymlink != 0 {
			e.Link = true
			if t, err := os.Stat(filepath.Join(dir, d.Name())); err == nil {
				e.Dir = t.IsDir()
			}
		}
		if e.Dir {
			e.Size = 0
		}
		out.Entries = append(out.Entries, e)
	}
	sort.Slice(out.Entries, func(i, j int) bool {
		a, b := out.Entries[i], out.Entries[j]
		if a.Dir != b.Dir {
			return a.Dir
		}
		return strings.ToLower(a.Name) < strings.ToLower(b.Name)
	})
	if _, ok := findGitDirs(root); ok {
		out.Git = true
		s.markGit(ctx, root, rel, &out)
	}
	return out, nil
}

// statusMark is a porcelain v2 record's one-letter mark.
func statusMark(e statusEntry) string {
	switch {
	case e.kind == '?':
		return "?"
	case e.kind == 'u':
		return "U"
	case e.x == 'A' || e.y == 'A':
		return "A"
	case e.y == 'D' || e.x == 'D':
		return "D"
	default:
		return "M"
	}
}

// markGit sets each entry's git mark from the root's status, and ! on the
// entries git ignores.
func (s *Service) markGit(ctx context.Context, root, rel string, l *FsListing) {
	st, err := s.readStatus(ctx, root)
	if err != nil {
		return
	}
	l.Branch = st.head
	prefix := ""
	if rel != "" {
		prefix = rel + "/"
	}
	marks := map[string]string{}
	for _, e := range st.entries {
		p, ok := strings.CutPrefix(e.path, prefix)
		if !ok || p == "" {
			continue
		}
		name, rest, sub := strings.Cut(p, "/")
		if sub && rest != "" {
			if marks[name] == "" {
				marks[name] = "."
			}
			continue
		}
		marks[name] = statusMark(e)
	}
	var names []string
	for i := range l.Entries {
		e := &l.Entries[i]
		if m := marks[e.Name]; m != "" {
			e.Git = m
		} else {
			names = append(names, prefix+e.Name)
		}
	}
	if len(names) == 0 {
		return
	}
	// check-ignore exits 1 when nothing is ignored; what it printed counts.
	r, _ := s.gitCmd(ctx, checkIgnoreOpts(names), root, "check-ignore", "-z", "--stdin")
	ignored := map[string]bool{}
	for _, p := range strings.Split(string(r.out), "\x00") {
		if p != "" {
			ignored[strings.TrimSuffix(strings.TrimPrefix(p, prefix), "/")] = true
		}
	}
	for i := range l.Entries {
		if l.Entries[i].Git == "" && ignored[l.Entries[i].Name] {
			l.Entries[i].Git = "!"
		}
	}
}

// candidates is every path, relative to the roots, that can differ
// between two checkouts of one repository: what differs between their
// HEADs, and what either has uncommitted or untracked. Ignored files are
// not in it.
func (s *Service) candidates(ctx context.Context, left, right string) (map[string]bool, bool) {
	stL, errL := s.readStatus(ctx, left)
	stR, errR := s.readStatus(ctx, right)
	if errL != nil || errR != nil {
		return nil, false
	}
	c := map[string]bool{}
	for _, e := range append(append([]statusEntry{}, stL.entries...), stR.entries...) {
		c[e.path] = true
		if e.origPath != "" {
			c[e.origPath] = true
		}
	}
	if stL.oid != "" && stR.oid != "" && stL.oid != stR.oid {
		r, err := s.gitCmd(ctx, readOpts, left, "diff", "--name-only", "--no-renames", "-z", stL.oid, stR.oid)
		if err != nil {
			return nil, false
		}
		for _, p := range strings.Split(string(r.out), "\x00") {
			if p != "" {
				c[p] = true
			}
		}
	} else if stL.oid == "" || stR.oid == "" {
		return nil, false
	}
	return c, true
}

// budget is what a comparison may still read.
type budget struct{ left int64 }

// sameFile reports whether two regular files hold the same bytes; false
// when the budget runs out (b.left < 0 then says so).
func sameFile(a, b string, bud *budget) bool {
	fa, err1 := os.Lstat(a)
	fb, err2 := os.Lstat(b)
	if err1 != nil || err2 != nil {
		return false
	}
	la, lb := fa.Mode()&fs.ModeSymlink != 0, fb.Mode()&fs.ModeSymlink != 0
	if la || lb {
		if la != lb {
			return false
		}
		ta, _ := os.Readlink(a)
		tb, _ := os.Readlink(b)
		return ta == tb
	}
	if fa.IsDir() != fb.IsDir() {
		return false
	}
	if !fa.Mode().IsRegular() || !fb.Mode().IsRegular() {
		return fa.Mode().Type() == fb.Mode().Type()
	}
	if fa.Size() != fb.Size() {
		return false
	}
	bud.left -= 2 * fa.Size()
	if bud.left < 0 {
		return true
	}
	ra, err := os.Open(a) //nolint:gosec // resolved inside a root by the caller
	if err != nil {
		return false
	}
	defer func() { _ = ra.Close() }()
	rb, err := os.Open(b) //nolint:gosec // resolved inside a root by the caller
	if err != nil {
		return false
	}
	defer func() { _ = rb.Close() }()
	ba, bb := make([]byte, 64<<10), make([]byte, 64<<10)
	for {
		na, ea := io.ReadFull(ra, ba)
		nb, eb := io.ReadFull(rb, bb)
		if na != nb || !bytes.Equal(ba[:na], bb[:nb]) {
			return false
		}
		if ea != nil || eb != nil {
			return (ea == io.EOF || errors.Is(ea, io.ErrUnexpectedEOF)) && (eb == io.EOF || errors.Is(eb, io.ErrUnexpectedEOF))
		}
	}
}

// CompareDir compares one folder, rel, between two roots of a project.
func (s *Service) CompareDir(ctx context.Context, id int64, leftWT, rightWT, rel string) (FsCompare, error) {
	lroot, err := s.fsRoot(ctx, id, leftWT)
	if err != nil {
		return FsCompare{}, err
	}
	rroot, err := s.fsRoot(ctx, id, rightWT)
	if err != nil {
		return FsCompare{}, err
	}
	out := FsCompare{Path: rel, States: map[string]string{}}
	read := func(root string) (string, map[string]os.DirEntry) {
		dir, err := fsDir(root, rel)
		if err != nil {
			return "", nil
		}
		des, err := os.ReadDir(dir)
		if err != nil {
			return dir, nil
		}
		m := make(map[string]os.DirEntry, len(des))
		for _, d := range des {
			m[d.Name()] = d
		}
		return dir, m
	}
	ldir, lm := read(lroot)
	rdir, rm := read(rroot)
	if lm == nil && rm == nil {
		if rel != "" {
			if err := checkRelPath(rel); err != nil {
				return FsCompare{}, err
			}
		}
		return FsCompare{}, ErrNoFile
	}
	// Git's own entry is a folder in the checkout and a file in a worktree:
	// never compared.
	for _, m := range []map[string]os.DirEntry{lm, rm} {
		for n := range m {
			if strings.EqualFold(n, ".git") {
				delete(m, n)
			}
		}
	}
	for n := range lm {
		if _, ok := rm[n]; !ok {
			out.States[n] = "left"
		}
	}
	for n := range rm {
		if _, ok := lm[n]; !ok {
			out.States[n] = "right"
		}
	}
	cand, git := s.candidates(ctx, lroot, rroot)
	var common []string
	for n := range lm {
		if _, ok := rm[n]; ok {
			common = append(common, n)
		}
	}
	sort.Strings(common)
	ignored := map[string]bool{}
	if git && len(common) > 0 {
		prefix := ""
		if rel != "" {
			prefix = rel + "/"
		}
		names := make([]string, len(common))
		for i, n := range common {
			names[i] = prefix + n
		}
		for _, root := range []string{lroot, rroot} {
			r, _ := s.gitCmd(ctx, checkIgnoreOpts(names), root, "check-ignore", "-z", "--stdin")
			for _, p := range strings.Split(string(r.out), "\x00") {
				if p != "" {
					ignored[strings.TrimSuffix(strings.TrimPrefix(p, prefix), "/")] = true
				}
			}
		}
	}
	bud := &budget{left: maxCompareRead}
	prefix := ""
	if rel != "" {
		prefix = rel + "/"
	}
	for _, n := range common {
		if ctx.Err() != nil {
			return FsCompare{}, ctx.Err()
		}
		la, ra := filepath.Join(ldir, n), filepath.Join(rdir, n)
		li, err1 := os.Stat(la)
		ri, err2 := os.Stat(ra)
		if err1 != nil || err2 != nil {
			if !sameFile(la, ra, bud) {
				out.States[n] = "diff"
			}
			continue
		}
		if li.IsDir() != ri.IsDir() {
			out.States[n] = "diff"
			continue
		}
		if !li.IsDir() {
			// A tracked file outside the candidates is the same on both
			// sides without reading it.
			if git && !ignored[n] && !cand[prefix+n] {
				continue
			}
			if !sameFile(la, ra, bud) {
				out.States[n] = "diff"
			}
			continue
		}
		if !git || ignored[n] {
			out.Unknown = append(out.Unknown, n)
			continue
		}
		sub := prefix + n + "/"
		for p := range cand {
			if !strings.HasPrefix(p, sub) {
				continue
			}
			lp, rp := filepath.Join(lroot, filepath.FromSlash(p)), filepath.Join(rroot, filepath.FromSlash(p))
			_, e1 := os.Lstat(lp)
			_, e2 := os.Lstat(rp)
			if (e1 == nil) != (e2 == nil) || (e1 == nil && !sameFile(lp, rp, bud)) {
				out.States[n] = "diff"
				break
			}
		}
	}
	out.Partial = bud.left < 0
	sort.Strings(out.Unknown)
	return out, nil
}

// Changed is what worktree changed since it left base's HEAD: `git diff
// --name-status` from their merge base to worktree's folder, and its
// untracked files.
func (s *Service) Changed(ctx context.Context, id int64, worktree, base string) (FsChanged, error) {
	root, err := s.fsRoot(ctx, id, worktree)
	if err != nil {
		return FsChanged{}, err
	}
	broot, err := s.fsRoot(ctx, id, base)
	if err != nil {
		return FsChanged{}, err
	}
	if _, ok := findGitDirs(root); !ok {
		return FsChanged{}, changeErr(KindState, "this folder is not a git checkout")
	}
	st, err := s.readStatus(ctx, root)
	if err != nil {
		return FsChanged{}, err
	}
	bst, err := s.readStatus(ctx, broot)
	if err != nil {
		return FsChanged{}, err
	}
	if st.oid == "" || bst.oid == "" {
		return FsChanged{}, changeErr(KindState, "a side has no commit yet")
	}
	mb, err := s.gitCmd(ctx, readOpts, root, "merge-base", st.oid, bst.oid)
	if err != nil {
		return FsChanged{}, err
	}
	mbase := strings.TrimSpace(string(mb.out))
	out := FsChanged{Base: mbase, Changes: []FsChange{}}
	r, err := s.gitCmd(ctx, readOpts, root, "diff", "--name-status", "--no-renames", "-z", mbase)
	if err != nil {
		return FsChanged{}, err
	}
	f := strings.Split(string(r.out), "\x00")
	for i := 0; i+1 < len(f); i += 2 {
		st := "modified"
		switch f[i] {
		case "A":
			st = "added"
		case "D":
			st = "deleted"
		}
		out.Changes = append(out.Changes, FsChange{Path: f[i+1], Status: st})
	}
	for _, e := range st.entries {
		if e.kind == '?' {
			out.Changes = append(out.Changes, FsChange{Path: e.path, Status: "untracked"})
		}
	}
	sort.Slice(out.Changes, func(i, j int) bool { return out.Changes[i].Path < out.Changes[j].Path })
	return out, nil
}

// readSide reads up to MaxDiffBytes+1 of a regular file inside root; ok is
// false when there is none.
func readSide(root, rel string) (b []byte, ok bool, err error) {
	real, err := resolveInside(root, rel)
	if errors.Is(err, ErrNoFile) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	fi, err := os.Stat(real)
	if err != nil {
		return nil, false, nil
	}
	if !fi.Mode().IsRegular() {
		return nil, false, ErrNotRegular
	}
	f, err := os.Open(real) //nolint:gosec // resolved inside the root above
	if err != nil {
		return nil, false, err
	}
	defer func() { _ = f.Close() }()
	b, err = io.ReadAll(io.LimitReader(f, MaxDiffBytes+1))
	return b, true, err
}

// DiffFile is rel compared left → right, as a unified diff.
func (s *Service) DiffFile(ctx context.Context, id int64, leftWT, rightWT, rel string) (FsDiff, error) {
	if err := checkRelPath(rel); err != nil {
		return FsDiff{}, err
	}
	lroot, err := s.fsRoot(ctx, id, leftWT)
	if err != nil {
		return FsDiff{}, err
	}
	rroot, err := s.fsRoot(ctx, id, rightWT)
	if err != nil {
		return FsDiff{}, err
	}
	a, lok, err := readSide(lroot, rel)
	if err != nil {
		return FsDiff{}, err
	}
	b, rok, err := readSide(rroot, rel)
	if err != nil {
		return FsDiff{}, err
	}
	out := FsDiff{Path: rel, Left: lok, Right: rok}
	if !lok && !rok {
		return FsDiff{}, ErrNoFile
	}
	if len(a) > MaxDiffBytes || len(b) > MaxDiffBytes {
		out.TooLarge = true
		return out, nil
	}
	if bytes.Equal(a, b) && lok == rok {
		out.Same = true
		return out, nil
	}
	if bytes.IndexByte(a, 0) >= 0 || bytes.IndexByte(b, 0) >= 0 || !utf8.Valid(a) || !utf8.Valid(b) {
		out.Binary = true
		return out, nil
	}
	out.Patch, out.Additions, out.Deletions, out.Truncated = unified(splitLines(a), splitLines(b))
	return out, nil
}

// Mkdir makes folder name inside dir.
func (s *Service) Mkdir(ctx context.Context, id int64, worktree, dir, name string) (FsResult, error) {
	if err := checkName(name); err != nil {
		return FsResult{}, err
	}
	root, err := s.fsRoot(ctx, id, worktree)
	if err != nil {
		return FsResult{}, err
	}
	d, err := fsDir(root, dir)
	if err != nil {
		return FsResult{}, err
	}
	if err := os.Mkdir(filepath.Join(d, name), 0o755); err != nil {
		if errors.Is(err, fs.ErrExist) {
			return FsResult{}, &ExistsError{Names: []string{name}}
		}
		return FsResult{}, changeErr(KindState, "the folder could not be made: %v", err)
	}
	go s.refreshNow(id)
	return FsResult{Done: 1}, nil
}

// fsSources resolves the items a copy or move acts on.
func fsSources(root string, paths []string) ([]string, error) {
	if len(paths) == 0 {
		return nil, changeErr(KindInvalid, "nothing named")
	}
	if len(paths) > 1000 {
		return nil, changeErr(KindInvalid, "at most 1,000 items at once")
	}
	out := make([]string, len(paths))
	for i, p := range paths {
		abs, err := fsItem(root, p)
		if err != nil {
			return nil, err
		}
		if err := guardItem(p, abs); err != nil {
			return nil, err
		}
		out[i] = abs
	}
	return out, nil
}

// Copy copies items of one root into a folder of another (or the same),
// keeping their names. A taken name is an ExistsError unless overwrite;
// then a file is replaced and a folder's contents copied over its own.
// A link inside a folder is copied as a link; nothing is followed out.
func (s *Service) Copy(ctx context.Context, id int64, fromWT string, paths []string, toWT, toDir string, overwrite bool) (FsResult, error) {
	sroot, err := s.fsRoot(ctx, id, fromWT)
	if err != nil {
		return FsResult{}, err
	}
	droot, err := s.fsRoot(ctx, id, toWT)
	if err != nil {
		return FsResult{}, err
	}
	srcs, err := fsSources(sroot, paths)
	if err != nil {
		return FsResult{}, err
	}
	dst, err := fsDir(droot, toDir)
	if err != nil {
		return FsResult{}, err
	}
	var taken []string
	var entries, total int64
	for _, src := range srcs {
		target := filepath.Join(dst, filepath.Base(src))
		if inside(src, dst) {
			return FsResult{}, changeErr(KindInvalid, "%s cannot be copied into itself", filepath.Base(src))
		}
		if ti, err := os.Lstat(target); err == nil {
			if si, err := os.Lstat(src); err == nil && os.SameFile(ti, si) {
				return FsResult{}, changeErr(KindInvalid, "%s is already there", filepath.Base(src))
			}
			taken = append(taken, filepath.Base(src))
		}
		_ = filepath.WalkDir(src, func(_ string, d fs.DirEntry, err error) error {
			if err != nil {
				return nil //nolint:nilerr // counted as nothing
			}
			entries++
			if d.Type().IsRegular() {
				if fi, err := d.Info(); err == nil {
					total += fi.Size()
				}
			}
			if entries > maxCopyEntries || total > maxCopyBytes {
				return filepath.SkipAll
			}
			return nil
		})
	}
	if entries > maxCopyEntries || total > maxCopyBytes {
		return FsResult{}, changeErr(KindState, "too large to copy here (over %d items or %d GB); use your file manager", maxCopyEntries, maxCopyBytes>>30)
	}
	if len(taken) > 0 && !overwrite {
		return FsResult{}, &ExistsError{Names: taken}
	}
	done := 0
	for _, src := range srcs {
		if err := copyTree(ctx, src, filepath.Join(dst, filepath.Base(src))); err != nil {
			go s.refreshNow(id)
			return FsResult{Done: done}, changeErr(KindState, "copying %s failed: %v", filepath.Base(src), err)
		}
		done++
	}
	go s.refreshNow(id)
	return FsResult{Done: done}, nil
}

// copyTree copies src to dst: a file with its mode and time, a link as a
// link, a folder entry by entry.
func copyTree(ctx context.Context, src, dst string) error {
	return filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		rel, err := filepath.Rel(src, p)
		if err != nil {
			return err
		}
		to := filepath.Join(dst, rel)
		fi, err := os.Lstat(p)
		if err != nil {
			return err
		}
		switch {
		case fi.Mode()&fs.ModeSymlink != 0:
			t, err := os.Readlink(p)
			if err != nil {
				return err
			}
			_ = os.Remove(to)
			return os.Symlink(t, to)
		case fi.IsDir():
			if tf, err := os.Lstat(to); err == nil && !tf.IsDir() {
				return fmt.Errorf("%s is a file there", rel)
			}
			return os.MkdirAll(to, fi.Mode().Perm()|0o700)
		case fi.Mode().IsRegular():
			return copyFile(p, to, fi)
		default:
			// A socket, a device or a FIFO is not copied.
			return nil
		}
	})
}

func copyFile(src, dst string, fi fs.FileInfo) error {
	if tf, err := os.Lstat(dst); err == nil && (tf.IsDir() || tf.Mode()&fs.ModeSymlink != 0) {
		if tf.IsDir() {
			return fmt.Errorf("%s is a folder there", filepath.Base(dst))
		}
		// Never write through a link at the target.
		if err := os.Remove(dst); err != nil {
			return err
		}
	}
	in, err := os.Open(src) //nolint:gosec // resolved inside a root by the caller
	if err != nil {
		return err
	}
	defer func() { _ = in.Close() }()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, fi.Mode().Perm()|0o600) //nolint:gosec // inside a root
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	return os.Chtimes(dst, fi.ModTime(), fi.ModTime())
}

// Move moves items of one root into a folder of another (or the same) by
// rename; with one item and a name, it is a rename. A taken name is an
// ExistsError: a move never replaces anything.
func (s *Service) Move(ctx context.Context, id int64, fromWT string, paths []string, toWT, toDir, name string) (FsResult, error) {
	sroot, err := s.fsRoot(ctx, id, fromWT)
	if err != nil {
		return FsResult{}, err
	}
	droot, err := s.fsRoot(ctx, id, toWT)
	if err != nil {
		return FsResult{}, err
	}
	srcs, err := fsSources(sroot, paths)
	if err != nil {
		return FsResult{}, err
	}
	if name != "" {
		if len(srcs) != 1 {
			return FsResult{}, changeErr(KindInvalid, "a new name is for one item")
		}
		if err := checkName(name); err != nil {
			return FsResult{}, err
		}
	}
	dst, err := fsDir(droot, toDir)
	if err != nil {
		return FsResult{}, err
	}
	var taken []string
	targets := make([]string, len(srcs))
	for i, src := range srcs {
		n := filepath.Base(src)
		if name != "" {
			n = name
		}
		targets[i] = filepath.Join(dst, n)
		if inside(src, dst) {
			return FsResult{}, changeErr(KindInvalid, "%s cannot be moved into itself", filepath.Base(src))
		}
		// A rename that only changes case is the same file on a
		// case-insensitive disk; that is allowed.
		if fi, err := os.Lstat(targets[i]); err == nil {
			if si, err := os.Lstat(src); err != nil || !os.SameFile(fi, si) {
				taken = append(taken, n)
			}
		}
	}
	if len(taken) > 0 {
		return FsResult{}, &ExistsError{Names: taken}
	}
	done := 0
	for i, src := range srcs {
		if err := os.Rename(src, targets[i]); err != nil {
			go s.refreshNow(id)
			return FsResult{Done: done}, changeErr(KindState, "moving %s failed: %v", filepath.Base(src), err)
		}
		done++
	}
	go s.refreshNow(id)
	return FsResult{Done: done}, nil
}

// Trash moves items of a root to the operating system's Trash. Nothing is
// ever deleted: where the Trash cannot take an item the call is refused.
func (s *Service) Trash(ctx context.Context, id int64, worktree string, paths []string) (FsResult, error) {
	if ok, why := trash.Supported(); !ok {
		return FsResult{}, changeErr(KindState, "Delete is off here: %s", why)
	}
	root, err := s.fsRoot(ctx, id, worktree)
	if err != nil {
		return FsResult{}, err
	}
	srcs, err := fsSources(root, paths)
	if err != nil {
		return FsResult{}, err
	}
	done := 0
	for _, src := range srcs {
		if err := trash.Move(src); err != nil {
			go s.refreshNow(id)
			return FsResult{Done: done}, changeErr(KindState, "%s was not moved to the Trash: %v", filepath.Base(src), err)
		}
		done++
	}
	go s.refreshNow(id)
	return FsResult{Done: done}, nil
}

// checkIgnoreOpts runs `check-ignore --stdin` over names. Not with
// --literal-pathspecs, which check-ignore refuses; what it reads on stdin
// are path names, never patterns, so nothing is lost.
func checkIgnoreOpts(names []string) gitOpts {
	return gitOpts{timeout: readTimeout, stdin: []byte(strings.Join(names, "\x00") + "\x00")}
}

// TrashSupported is whether Delete works on this machine, and why not.
func TrashSupported() (bool, string) { return trash.Supported() }

// splitLines splits text into lines without their line breaks; a final
// break ends the last line rather than starting an empty one.
func splitLines(b []byte) []string {
	if len(b) == 0 {
		return nil
	}
	s := strings.TrimSuffix(string(b), "\n")
	return strings.Split(s, "\n")
}

// maxLCSCells caps the table the line diff builds; past it, the changed
// middle is shown as removed and added whole.
const maxLCSCells = 4 << 20

// diffContext is how many unchanged lines a hunk keeps around a change.
const diffContext = 3

// unified is a's lines → b's as a unified diff with diffContext lines of context.
func unified(a, b []string) (patch string, add, del int, truncated bool) {
	ctx := diffContext
	type op struct {
		k    byte
		text string
		ai   int
		bi   int
	}
	pre := 0
	for pre < len(a) && pre < len(b) && a[pre] == b[pre] {
		pre++
	}
	suf := 0
	for suf < len(a)-pre && suf < len(b)-pre && a[len(a)-1-suf] == b[len(b)-1-suf] {
		suf++
	}
	ma, mb := a[pre:len(a)-suf], b[pre:len(b)-suf]
	var ops []op
	for i := 0; i < pre; i++ {
		ops = append(ops, op{' ', a[i], i, i})
	}
	n, m := len(ma), len(mb)
	if n*m <= maxLCSCells && n > 0 && m > 0 {
		// lcs[i][j] is the LCS length of ma[i:] and mb[j:].
		w := m + 1
		lcs := make([]int32, (n+1)*w)
		for i := n - 1; i >= 0; i-- {
			for j := m - 1; j >= 0; j-- {
				if ma[i] == mb[j] {
					lcs[i*w+j] = lcs[(i+1)*w+j+1] + 1
				} else if lcs[(i+1)*w+j] >= lcs[i*w+j+1] {
					lcs[i*w+j] = lcs[(i+1)*w+j]
				} else {
					lcs[i*w+j] = lcs[i*w+j+1]
				}
			}
		}
		i, j := 0, 0
		for i < n || j < m {
			switch {
			case i < n && j < m && ma[i] == mb[j]:
				ops = append(ops, op{' ', ma[i], pre + i, pre + j})
				i++
				j++
			case i < n && (j == m || lcs[(i+1)*w+j] >= lcs[i*w+j+1]):
				// A removal before an addition, as a unified diff writes them.
				ops = append(ops, op{'-', ma[i], pre + i, pre + j})
				i++
			default:
				ops = append(ops, op{'+', mb[j], pre + i, pre + j})
				j++
			}
		}
	} else {
		for i := 0; i < n; i++ {
			ops = append(ops, op{'-', ma[i], pre + i, pre})
		}
		for j := 0; j < m; j++ {
			ops = append(ops, op{'+', mb[j], pre + n, pre + j})
		}
	}
	for i := 0; i < suf; i++ {
		ops = append(ops, op{' ', a[len(a)-suf+i], len(a) - suf + i, len(b) - suf + i})
	}
	var sb strings.Builder
	lines := 0
	for k := 0; k < len(ops); {
		if ops[k].k == ' ' {
			k++
			continue
		}
		start := max(k-ctx, 0)
		end := k
		for end < len(ops) {
			if ops[end].k != ' ' {
				end++
				continue
			}
			run := end
			for run < len(ops) && ops[run].k == ' ' {
				run++
			}
			if run == len(ops) || run-end > 2*ctx {
				end = min(end+ctx, len(ops))
				break
			}
			end = run
		}
		aStart, bStart, aLen, bLen := ops[start].ai, ops[start].bi, 0, 0
		for _, o := range ops[start:end] {
			if o.k != '+' {
				aLen++
			}
			if o.k != '-' {
				bLen++
			}
		}
		as, bs := aStart+1, bStart+1
		if aLen == 0 {
			as = aStart
		}
		if bLen == 0 {
			bs = bStart
		}
		fmt.Fprintf(&sb, "@@ -%d,%d +%d,%d @@\n", as, aLen, bs, bLen)
		for _, o := range ops[start:end] {
			switch o.k {
			case '+':
				add++
			case '-':
				del++
			}
			if lines < maxDiffLines {
				sb.WriteByte(o.k)
				sb.WriteString(strings.TrimSuffix(o.text, "\r"))
				sb.WriteByte('\n')
				lines++
			} else {
				truncated = true
			}
		}
		k = end
	}
	return sb.String(), add, del, truncated
}
