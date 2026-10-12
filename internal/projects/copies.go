package projects

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/store"
	"github.com/dspv/caprock/internal/tcc"
)

// Copies: every git worktree of a project, with what removing one would lose
// and how much disk it takes, and the removal itself (.ai/21-app.md
// § Projects, "Clean up copies"; contract in 03-contracts.md § Projects and
// shells).
//
// The list is `git worktree list --porcelain`, so it holds the worktrees a
// person made by hand too; only the ones under <root>/.caprock-worktrees are
// Caprock's, and only those are removed from here. The main checkout is
// listed and never removed.

// Copy is one worktree of a project as the copies view shows it.
type Copy struct {
	// Name is git's name for a linked worktree (<common>/worktrees/<name>);
	// empty for the main checkout.
	Name     string `json:"name,omitempty"`
	Path     string `json:"path"` // the OS's own form
	Main     bool   `json:"main,omitempty"`
	Branch   string `json:"branch,omitempty"`
	Head     string `json:"head,omitempty"` // the commit
	Detached bool   `json:"detached,omitempty"`
	Caprock  bool   `json:"caprock"`
	Locked   bool   `json:"locked,omitempty"`
	// Missing is a worktree whose folder is gone (git calls it prunable).
	Missing bool `json:"missing,omitempty"`
	// CommittedAt is the newest commit's time, Unix seconds; 0 unknown.
	CommittedAt int64 `json:"committed_at,omitempty"`
	// Merged: every commit on it is in the default branch (local or
	// origin's), so deleting the branch loses nothing. Never set for the
	// default branch itself or the main checkout.
	Merged bool `json:"merged"`
	// Unpushed counts commits on it that no remote has; only meaningful
	// when the repository has a remote (HasRemote on the view).
	Unpushed int `json:"unpushed"`
	// Orphaned counts commits on a detached HEAD that no branch or remote
	// holds: removing the copy leaves them reachable only from the reflog.
	Orphaned int  `json:"orphaned,omitempty"`
	Dirty    bool `json:"dirty"`
	Changed  int  `json:"changed"`
	// Live names what runs in it: a session or a shell. A copy with any is
	// not removed.
	Live []string `json:"live"`
	// Size is the folder's size in bytes, null while it is being measured
	// (and always for the main checkout, which is not measured).
	Size *int64 `json:"size"`
	// SizeCapped: the walk stopped at its file or time limit, so Size is a
	// floor.
	SizeCapped bool `json:"size_capped,omitempty"`
	// Stale: a copy Caprock made with no commit for 14 days and no pull
	// request known for its branch. Suggested, never removed for it
	// (cleanup.go).
	Stale bool   `json:"stale,omitempty"`
	Error string `json:"error,omitempty"`
}

// CopiesView is a project's copies and their total size.
type CopiesView struct {
	Copies        []Copy `json:"copies"`
	DefaultBranch string `json:"default_branch,omitempty"`
	HasRemote     bool   `json:"has_remote"`
	// Total is the sum of the linked copies' known sizes; Pending says some
	// are still being measured, Capped that some are floors.
	Total   int64 `json:"total"`
	Pending bool  `json:"pending,omitempty"`
	Capped  bool  `json:"capped,omitempty"`
}

// BusyFunc says what is running in a folder or below it — sessions and
// shells — by names a person recognises, leaving out what runs inside any of
// except (the copies nested in it: Caprock's live under the main checkout).
// The API supplies it.
type BusyFunc func(dir string, except []string) []string

// nestedIn lists the paths of the other copies that lie inside dir.
func nestedIn(dir string, all []Copy) []string {
	var out []string
	for _, c := range all {
		if cleanKey(c.Path) == cleanKey(dir) {
			continue
		}
		rel, err := filepath.Rel(dir, c.Path)
		if err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel) {
			out = append(out, c.Path)
		}
	}
	return out
}

// porcelainEntry is one record of `git worktree list --porcelain`.
type porcelainEntry struct {
	Path     string
	Head     string
	Branch   string
	Detached bool
	Bare     bool
	Locked   bool
	Prunable bool
}

// parsePorcelain reads `git worktree list --porcelain`: blank-line separated
// records of "worktree <path>", "HEAD <sha>", "branch <ref>" | "detached" |
// "bare", and optional "locked [reason]" and "prunable [reason]". Paths come
// back in the OS's own form (git on Windows prints forward slashes).
func parsePorcelain(out string) []porcelainEntry {
	var list []porcelainEntry
	var cur *porcelainEntry
	for _, line := range strings.Split(strings.ReplaceAll(out, "\r\n", "\n"), "\n") {
		key, val, _ := strings.Cut(line, " ")
		if key == "worktree" {
			list = append(list, porcelainEntry{Path: filepath.Clean(filepath.FromSlash(val))})
			cur = &list[len(list)-1]
			continue
		}
		if cur == nil {
			continue
		}
		switch key {
		case "HEAD":
			cur.Head = val
		case "branch":
			cur.Branch = strings.TrimPrefix(val, "refs/heads/")
		case "detached":
			cur.Detached = true
		case "bare":
			cur.Bare = true
		case "locked":
			cur.Locked = true
		case "prunable":
			cur.Prunable = true
		}
	}
	return list
}

// copiesRepo is what the listing needs about a project's repository.
type copiesRepo struct {
	root          string
	common        string
	defaultBranch string
	defaultRefs   []string // refs/heads/<d>, refs/remotes/origin/<d>: those that exist
	hasRemote     bool
	names         map[string]string // cleanKey(worktree path) -> git's name
}

func (s *Service) copiesRepo(ctx context.Context, id int64) (copiesRepo, error) {
	p, err := store.GetProject(ctx, s.Store.DB(), id)
	if err != nil {
		return copiesRepo{}, err
	}
	if p.Kind != store.ProjectKindRepo {
		return copiesRepo{}, errors.New("this project is not a git repository")
	}
	root := filepath.FromSlash(p.Root)
	gd, ok := findGitDirs(root)
	if !ok {
		return copiesRepo{}, fmt.Errorf("no git repository at %s", root)
	}
	r := copiesRepo{root: root, common: gd.common, defaultBranch: readDefaultBranch(gd.common), names: map[string]string{}}
	if r.defaultBranch != "" {
		for _, ref := range []string{"refs/heads/" + r.defaultBranch, "refs/remotes/origin/" + r.defaultBranch} {
			if _, err := runGit(ctx, s.GitTimeout, root, "rev-parse", "--verify", "--quiet", ref); err == nil {
				r.defaultRefs = append(r.defaultRefs, ref)
			}
		}
	}
	if out, err := runGit(ctx, s.GitTimeout, root, "remote"); err == nil && strings.TrimSpace(string(out)) != "" {
		r.hasRemote = true
	}
	for _, w := range readWorktrees(gd.common, filepath.Join(root, agents.WorktreeDir)) {
		r.names[cleanKey(w.Path)] = w.Name
	}
	return r, nil
}

// cleanKey is a path as a map key: cleaned, and case-folded where the file
// system usually is (Windows, macOS).
func cleanKey(p string) string {
	p = filepath.Clean(p)
	if runtime.GOOS == "windows" || runtime.GOOS == "darwin" {
		p = strings.ToLower(p)
	}
	return p
}

func (s *Service) listPorcelain(ctx context.Context, r copiesRepo) ([]porcelainEntry, error) {
	out, err := runGit(ctx, s.GitTimeout, r.root, "worktree", "list", "--porcelain")
	if err != nil {
		return nil, err
	}
	list := parsePorcelain(string(out))
	for i := range list {
		list[i].Path = spellUnder(r.root, list[i].Path)
	}
	return list, nil
}

// spellUnder gives a path under root the root's own spelling: git prints
// paths with symlinks resolved (/private/var/… on macOS), while the project,
// and everything a client compares with, uses the form it was listed by.
func spellUnder(root, path string) string {
	real, err := filepath.EvalSymlinks(root)
	if err != nil || cleanKey(real) == cleanKey(root) {
		return path
	}
	rel, err := filepath.Rel(real, path)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return path
	}
	return filepath.Join(root, rel)
}

// inspect fills in one copy's git state. It runs a handful of git commands in
// the copy's folder; a missing folder runs none.
func (s *Service) inspect(ctx context.Context, r copiesRepo, e porcelainEntry, main bool) Copy {
	c := Copy{Path: e.Path, Main: main, Branch: e.Branch, Head: e.Head, Detached: e.Detached, Locked: e.Locked, Live: []string{}}
	if !main {
		c.Name = r.names[cleanKey(e.Path)]
		if c.Name == "" {
			c.Name = nameFromDotGit(e.Path)
		}
		c.Caprock = sameFolder(filepath.Dir(e.Path), filepath.Join(r.root, agents.WorktreeDir))
	}
	if fi, err := os.Stat(e.Path); e.Prunable || err != nil || !fi.IsDir() {
		c.Missing = true
		return c
	}
	st := s.status(ctx, e.Path, GitStatus{})
	c.Dirty, c.Changed, c.Error = st.Dirty, st.Changed, st.Error
	if out, err := runGit(ctx, s.GitTimeout, e.Path, "log", "-1", "--format=%ct", "HEAD"); err == nil {
		c.CommittedAt, _ = strconv.ParseInt(strings.TrimSpace(string(out)), 10, 64)
	}
	if !main && c.Branch != r.defaultBranch {
		c.Merged = s.mergedInto(ctx, e.Path, "HEAD", r.defaultRefs)
	}
	if r.hasRemote {
		c.Unpushed = s.countCommits(ctx, e.Path, "HEAD", "--not", "--remotes")
	}
	if c.Detached {
		c.Orphaned = s.countCommits(ctx, e.Path, "HEAD", "--not", "--branches", "--remotes")
	}
	return c
}

// mergedInto reports whether rev is an ancestor of any of refs.
func (s *Service) mergedInto(ctx context.Context, dir, rev string, refs []string) bool {
	for _, ref := range refs {
		if _, err := runGit(ctx, s.GitTimeout, dir, "merge-base", "--is-ancestor", rev, ref); err == nil {
			return true
		}
	}
	return false
}

// countCommits is `git rev-list --count <args>`, 0 when git cannot say.
func (s *Service) countCommits(ctx context.Context, dir string, args ...string) int {
	out, err := runGit(ctx, s.GitTimeout, dir, append([]string{"rev-list", "--count"}, args...)...)
	if err != nil {
		return 0
	}
	n, _ := strconv.Atoi(strings.TrimSpace(string(out)))
	return n
}

// nameFromDotGit reads git's name for a linked worktree from its `.git` file
// ("gitdir: <common>/worktrees/<name>").
func nameFromDotGit(path string) string {
	b, err := os.ReadFile(filepath.Join(path, ".git"))
	if err != nil {
		return ""
	}
	g, ok := strings.CutPrefix(strings.TrimSpace(string(b)), "gitdir:")
	if !ok {
		return ""
	}
	return filepath.Base(filepath.Clean(strings.TrimSpace(g)))
}

// copiesParallel is how many copies are inspected at once.
const copiesParallel = 2

// Copies lists every worktree of a project, the main checkout first, with
// each linked copy's size from the cache; a size not yet known is measured in
// the background and is null until then.
func (s *Service) Copies(ctx context.Context, id int64, busy BusyFunc) (CopiesView, error) {
	r, err := s.copiesRepo(ctx, id)
	if err != nil {
		return CopiesView{}, err
	}
	return s.copiesOf(ctx, id, r, busy)
}

// copiesOf is Copies for a repository already read.
func (s *Service) copiesOf(ctx context.Context, id int64, r copiesRepo, busy BusyFunc) (CopiesView, error) {
	entries, err := s.listPorcelain(ctx, r)
	if err != nil {
		return CopiesView{}, err
	}
	v := CopiesView{Copies: make([]Copy, len(entries)), DefaultBranch: r.defaultBranch, HasRemote: r.hasRemote}
	sem := make(chan struct{}, copiesParallel)
	var wg sync.WaitGroup
	for i, e := range entries {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int, e porcelainEntry) {
			defer wg.Done()
			defer func() { <-sem }()
			// The first record is the main worktree, unless the repository
			// is bare, which a listed project never is.
			v.Copies[i] = s.inspect(ctx, r, e, i == 0 && !e.Bare)
		}(i, e)
	}
	wg.Wait()
	for i := range v.Copies {
		c := &v.Copies[i]
		if busy != nil && !c.Missing {
			if live := busy(c.Path, nestedIn(c.Path, v.Copies)); len(live) > 0 {
				c.Live = live
			}
		}
		if c.Main || c.Missing {
			continue
		}
		c.Stale = s.isStale(id, *c)
		size, capped, known := s.sizes().get(s, c.Path)
		if !known {
			v.Pending = true
			continue
		}
		c.Size, c.SizeCapped = &size, capped
		v.Total += size
		v.Capped = v.Capped || capped
	}
	return v, nil
}

// CopyRemoval asks to remove one copy. Force says the person has seen what
// would be lost — uncommitted changes, unpushed or orphaned commits — and
// confirmed it.
type CopyRemoval struct {
	Path  string `json:"path"`
	Force bool   `json:"force,omitempty"`
}

// CopyRemoved is what happened to one copy.
type CopyRemoved struct {
	Path    string `json:"path"`
	Removed bool   `json:"removed"`
	// BranchDeleted is the local branch deleted with it, when asked and
	// merged.
	BranchDeleted string `json:"branch_deleted,omitempty"`
	// Confirm is set when the copy was kept because it would lose work and
	// the request did not say force; Error says what.
	Confirm bool   `json:"confirm,omitempty"`
	Error   string `json:"error,omitempty"`
}

// ErrCopyNeedsConfirm is a removal that would lose work, asked without Force.
var ErrCopyNeedsConfirm = errors.New("removing it would lose work")

// RemoveCopies removes the copies asked for, one at a time, each judged on
// its state now rather than when the list was shown. Only a copy Caprock made
// is removed; never the main checkout, a locked copy or one with a session or
// shell running in it. A copy with changes, unpushed or orphaned commits
// needs Force. With deleteMerged the copy's local branch goes too, but only
// when every commit on it is in the default branch.
func (s *Service) RemoveCopies(ctx context.Context, id int64, asks []CopyRemoval, deleteMerged bool, busy BusyFunc) ([]CopyRemoved, error) {
	r, err := s.copiesRepo(ctx, id)
	if err != nil {
		return nil, err
	}
	out := make([]CopyRemoved, 0, len(asks))
	for _, a := range asks {
		res := CopyRemoved{Path: a.Path}
		gone, err := s.removeCopy(ctx, r, a, deleteMerged, busy, &res)
		if err != nil {
			res.Error = err.Error()
			res.Confirm = errors.Is(err, ErrCopyNeedsConfirm)
		}
		if res.Removed {
			s.recordRemoval(id, gone, cleanupManual, res.BranchDeleted != "")
		}
		out = append(out, res)
	}
	s.refreshNow(id)
	return out, nil
}

// removedCopy is what a removal took away, for the cleanup history.
type removedCopy struct {
	copy  Copy
	bytes int64
}

func (s *Service) removeCopy(ctx context.Context, r copiesRepo, a CopyRemoval, deleteMerged bool, busy BusyFunc, res *CopyRemoved) (removedCopy, error) {
	var gone removedCopy
	path := filepath.FromSlash(strings.TrimSpace(a.Path))
	if path == "" || !filepath.IsAbs(path) {
		return gone, fmt.Errorf("%q is not a worktree path", a.Path)
	}
	path = filepath.Clean(path)
	entries, err := s.listPorcelain(ctx, r)
	if err != nil {
		return gone, err
	}
	idx := -1
	for i, e := range entries {
		if cleanKey(e.Path) == cleanKey(path) || sameFolder(e.Path, path) {
			idx = i
			break
		}
	}
	switch {
	case idx < 0:
		return gone, errors.New("not a worktree of this project")
	case idx == 0 || sameFolder(entries[idx].Path, r.root):
		return gone, errors.New("the main checkout is never removed")
	}
	c := s.inspect(ctx, r, entries[idx], false)
	switch {
	case !c.Caprock:
		return gone, errors.New("made outside Caprock, so Caprock leaves it to you (git worktree remove)")
	case c.Locked:
		return gone, errors.New("the copy is locked (git worktree unlock first)")
	}
	if busy != nil && !c.Missing {
		if live := busy(c.Path, nil); len(live) > 0 {
			return gone, fmt.Errorf("%s running in it; stop it first", strings.Join(live, ", "))
		}
	}
	if loss := lossOf(c, r.hasRemote); loss != "" && !a.Force {
		return gone, fmt.Errorf("%w: %s", ErrCopyNeedsConfirm, loss)
	}
	if s.watch != nil && c.Name != "" {
		// Windows will not remove a directory something holds open.
		s.watch.unwatchTree(filepath.Join(r.common, "worktrees", c.Name))
	}
	args := []string{"worktree", "remove"}
	if a.Force || c.Missing {
		args = append(args, "--force")
	}
	if _, err := runGit(ctx, time.Minute, r.root, append(args, c.Path)...); err != nil {
		return gone, err
	}
	res.Removed = true
	gone.copy = c
	gone.bytes, _, _ = s.sizes().peek(c.Path)
	s.sizes().forget(c.Path)
	if deleteMerged && c.Branch != "" && c.Branch != r.defaultBranch &&
		s.mergedInto(ctx, r.root, "refs/heads/"+c.Branch, r.defaultRefs) {
		// -D: git's own -d judges against the main checkout's HEAD, which
		// need not be the default branch; merged was checked just above.
		if _, err := runGit(ctx, s.GitTimeout, r.root, "branch", "-D", c.Branch); err != nil {
			return gone, fmt.Errorf("the copy is removed; its branch %s is kept: %w", c.Branch, err)
		}
		res.BranchDeleted = c.Branch
	}
	return gone, nil
}

// lossOf says what removing c would lose, "" when nothing. Commits on a
// branch are not lost with the copy (the branch stays), but a person cleaning
// up may not know they were never pushed, so they are named too.
func lossOf(c Copy, hasRemote bool) string {
	var parts []string
	if c.Dirty {
		parts = append(parts, plural(c.Changed, "uncommitted change", "uncommitted changes"))
	}
	if hasRemote && c.Unpushed > 0 && !c.Detached {
		parts = append(parts, plural(c.Unpushed, "commit", "commits")+" on no remote")
	}
	if c.Orphaned > 0 {
		parts = append(parts, plural(c.Orphaned, "commit", "commits")+" on no branch")
	}
	return strings.Join(parts, ", ")
}

func plural(n int, one, many string) string {
	if n == 1 {
		return "1 " + one
	}
	return strconv.Itoa(n) + " " + many
}

// ── Sizes ────────────────────────────────────────────────────────────────

// The size walk's limits: a copy with a huge node_modules gets a floor, not
// a daemon busy for minutes. Variables so a test can lower them.
var (
	sizeMaxFiles = 300_000
	sizeMaxTime  = 20 * time.Second
	sizeTTL      = 10 * time.Minute
)

type sizeEntry struct {
	bytes  int64
	capped bool
	at     time.Time
}

// sizeCache measures folders one at a time in the background and keeps the
// answers for sizeTTL; a stale answer is served while it is measured again.
type sizeCache struct {
	mu      sync.Mutex
	m       map[string]sizeEntry
	queue   []string
	queued  map[string]bool
	running bool
}

func (s *Service) sizes() *sizeCache {
	s.sizeOnce.Do(func() { s.sizeCache = &sizeCache{m: map[string]sizeEntry{}, queued: map[string]bool{}} })
	return s.sizeCache
}

// get returns path's size when known, and queues a measurement when it is
// unknown or stale.
func (z *sizeCache) get(s *Service, path string) (int64, bool, bool) {
	key := cleanKey(path)
	z.mu.Lock()
	defer z.mu.Unlock()
	e, ok := z.m[key]
	if (!ok || time.Since(e.at) > sizeTTL) && !z.queued[key] && !s.closed.Load() {
		z.queued[key] = true
		z.queue = append(z.queue, path)
		if !z.running {
			z.running = true
			go z.work(s)
		}
	}
	return e.bytes, e.capped, ok
}

// peek is a known size, without measuring.
func (z *sizeCache) peek(path string) (int64, bool, bool) {
	z.mu.Lock()
	defer z.mu.Unlock()
	e, ok := z.m[cleanKey(path)]
	return e.bytes, e.capped, ok
}

func (z *sizeCache) forget(path string) {
	z.mu.Lock()
	delete(z.m, cleanKey(path))
	z.mu.Unlock()
}

// work measures the queue, one folder at a time, until it is empty.
func (z *sizeCache) work(s *Service) {
	for {
		z.mu.Lock()
		if len(z.queue) == 0 {
			z.running = false
			z.mu.Unlock()
			return
		}
		path := z.queue[0]
		z.queue = z.queue[1:]
		z.mu.Unlock()
		bytes, capped := s.measure(path)
		z.mu.Lock()
		key := cleanKey(path)
		delete(z.queued, key)
		z.m[key] = sizeEntry{bytes: bytes, capped: capped, at: time.Now()}
		z.mu.Unlock()
	}
}

var errSizeCap = errors.New("size limit reached")

// measure adds up the sizes of the files under dir without following links,
// stopping at sizeMaxFiles entries or after sizeMaxTime; capped says it
// stopped early. A folder the daemon must not read (tcc) measures 0, capped.
func (s *Service) measure(dir string) (int64, bool) {
	s.life.RLock()
	defer s.life.RUnlock()
	if s.closed.Load() || tcc.Check(dir) != nil {
		return 0, true
	}
	ctx := s.ctx
	if ctx == nil {
		ctx = context.Background()
	}
	deadline := time.Now().Add(sizeMaxTime)
	var total int64
	n := 0
	err := filepath.WalkDir(dir, func(_ string, d fs.DirEntry, err error) error {
		if err != nil {
			if d != nil && d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		n++
		if n > sizeMaxFiles {
			return errSizeCap
		}
		if n%256 == 0 && (time.Now().After(deadline) || ctx.Err() != nil || s.closed.Load()) {
			return errSizeCap
		}
		if d.Type().IsRegular() {
			if fi, err := d.Info(); err == nil {
				total += fi.Size()
			}
		}
		return nil
	})
	return total, errors.Is(err, errSizeCap)
}
