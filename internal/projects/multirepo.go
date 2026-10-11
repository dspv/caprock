package projects

// Multi-repo projects (ADR-055): a folder holding several git repositories,
// listed as one project whose member repositories are named in
// project_repos (migration 0050).
//
// Kept light on purpose. Member repositories are never watched: a folder of
// twelve repositories would otherwise be twelve more fsnotify trees for a
// list that changes when the user says so. Each member's git state is read
// once when the project is added or edited, when an agent edits inside that
// member, and when the project page asks (at most every memberGitTTL) — never
// on a timer, and never because GET /v1/projects was asked.

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/dspv/caprock/internal/store"
	"github.com/dspv/caprock/internal/tcc"
)

const (
	// ScanDepth is how far below a folder Add project looks for
	// repositories: ~/work/api (1) and ~/work/services/web (2).
	ScanDepth = 2
	// scanVisit caps the directories one scan opens, and scanLimit the
	// repositories it reports.
	scanVisit = 4000
	scanLimit = 200
	// memberGitTTL is how old a member's git answer may be before the
	// project page asking for it reads it again.
	memberGitTTL = 30 * time.Second
	// MaxRepos caps a multi-repo project's members.
	MaxRepos = 100
)

// scanSkip are folder names never descended into: dependency and build trees,
// where a vendored checkout is not a project.
var scanSkip = map[string]bool{"node_modules": true, "vendor": true, "Pods": true, "__pycache__": true, "target": true}

// FoundRepo is one repository a scan found below a folder.
type FoundRepo struct {
	Path string `json:"path"` // the OS's own form
	// Name is its path below the scanned folder, forward slashes: "api",
	// "services/web".
	Name string `json:"name"`
	// ProjectID is set when the repository is listed as a project of its
	// own; MemberOf when it is a member of a multi-repo project.
	ProjectID   int64  `json:"project_id,omitempty"`
	ProjectName string `json:"project_name,omitempty"`
	MemberOf    int64  `json:"member_of,omitempty"`
}

// ScanResult is GET /v1/projects/scan.
type ScanResult struct {
	Root string `json:"root"`
	// RepoRoot is set when the folder is inside a repository: adding it
	// adds that repository, and there is nothing to choose.
	RepoRoot string      `json:"repo_root,omitempty"`
	Repos    []FoundRepo `json:"repos"`
	Capped   bool        `json:"capped,omitempty"`
}

// RepoView is one member of a multi-repo project, with its own git state
// and the share of the project's sessions and spend that ran in it.
type RepoView struct {
	Path         string     `json:"path"` // the OS's own form
	Name         string     `json:"name"` // below the project's root, else its last segment
	Exists       bool       `json:"exists"`
	Git          *GitStatus `json:"git"` // null until git first answers
	Sessions     Sessions   `json:"sessions"`
	CostToday    float64    `json:"cost_today"`
	LastActivity int64      `json:"last_activity"`
	// OpenPRs is the repository's open pull requests on GitHub, when the
	// project page asked for them (GET /v1/projects/{id}/repos) and GitHub
	// is connected; PRsError says why there is no count.
	OpenPRs  *int   `json:"open_prs,omitempty"`
	PRsError string `json:"prs_error,omitempty"`
}

// memberGit is one member repository's cached git answer.
type memberGit struct {
	status  GitStatus
	tried   time.Time // when git was last asked, answered or not
	running bool
	timer   *time.Timer
}

// FindRepos lists the git repositories at most depth levels below dir, in
// path order. A repository is not descended into; hidden folders, dependency
// trees and, below a folder macOS does not guard, guarded ones are skipped.
// capped says the walk stopped at its limits.
func FindRepos(dir string, depth int) ([]string, bool) {
	var out []string
	visited := 0
	capped := false
	guardedRoot := tcc.Guarded(dir)
	var walk func(d string, level int)
	walk = func(d string, level int) {
		if level > depth || capped {
			return
		}
		if visited >= scanVisit {
			capped = true
			return
		}
		visited++
		des, err := os.ReadDir(d)
		if err != nil {
			return
		}
		for _, de := range des {
			name := de.Name()
			if strings.HasPrefix(name, ".") || scanSkip[name] {
				continue
			}
			p := filepath.Join(d, name)
			if !guardedRoot && tcc.Guarded(p) {
				continue
			}
			if de.Type()&os.ModeSymlink != 0 {
				if fi, err := os.Stat(p); err != nil || !fi.IsDir() {
					continue
				}
			} else if !de.IsDir() {
				continue
			}
			if _, err := os.Stat(filepath.Join(p, ".git")); err == nil {
				if len(out) >= scanLimit {
					capped = true
					return
				}
				out = append(out, p)
				continue
			}
			walk(p, level+1)
		}
	}
	walk(dir, 1)
	sort.Strings(out)
	return out, capped
}

// Scan says what adding dir would add: the repository it is in, or the
// repositories below it (ScanDepth), each marked when it is already listed.
func (s *Service) Scan(ctx context.Context, path string) (ScanResult, error) {
	dir, err := existingDir(path)
	if err != nil {
		return ScanResult{}, err
	}
	if err := tcc.Check(dir); err != nil {
		return ScanResult{}, err
	}
	out := ScanResult{Root: dir, Repos: []FoundRepo{}}
	if r := store.ResolveRepoRoot(dir); r != "" {
		out.RepoRoot = filepath.FromSlash(r)
		return out, nil
	}
	paths, capped := FindRepos(dir, ScanDepth)
	out.Capped = capped
	all, err := store.ListProjects(ctx, s.Store.DB(), false)
	if err != nil {
		return ScanResult{}, err
	}
	byRoot := map[string]store.Project{}
	for _, p := range all {
		byRoot[p.Root] = p
	}
	s.mu.Lock()
	owner := s.memberOwnerLocked()
	s.mu.Unlock()
	for _, p := range paths {
		f := FoundRepo{Path: p, Name: relName(dir, p)}
		n := store.NormalizeDir(p)
		if lp, ok := byRoot[n]; ok {
			f.ProjectID, f.ProjectName = lp.ID, lp.Name
		}
		if id, ok := owner[n]; ok {
			f.MemberOf = id
		}
		out.Repos = append(out.Repos, f)
	}
	return out, nil
}

// relName is p below root with forward slashes, or p's last segment when it
// is not below root.
func relName(root, p string) string {
	if r, err := filepath.Rel(root, p); err == nil && r != "." && !strings.HasPrefix(r, "..") {
		return filepath.ToSlash(r)
	}
	return baseName(p)
}

// memberOwnerLocked maps each member repository of a listed project to that
// project. s.mu is held.
func (s *Service) memberOwnerLocked() map[string]int64 {
	out := map[string]int64{}
	for id, ms := range s.members {
		if _, listed := s.projects[id]; !listed {
			continue
		}
		for _, m := range ms {
			out[m] = id
		}
	}
	return out
}

// Repos is a listed project's member repositories (normalised), nil for an
// ordinary project.
func (s *Service) Repos(id int64) []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.members[id]...)
}

// checkRepos turns the paths a request named into repository roots: each an
// existing absolute folder inside a git repository, which is the member (a
// folder inside a repository names the repository).
func checkRepos(paths []string) ([]string, error) {
	if len(paths) > MaxRepos {
		return nil, fmt.Errorf("a project holds at most %d repositories", MaxRepos)
	}
	var out []string
	for _, p := range paths {
		dir, err := existingDir(p)
		if err != nil {
			return nil, err
		}
		r := store.ResolveRepoRoot(dir)
		if r == "" {
			return nil, fmt.Errorf("%s is not in a git repository", dir)
		}
		out = append(out, r)
	}
	return store.CleanRepoPaths(out), nil
}

// AddMulti lists root as one project of the repositories repos (at least
// two). A repository listed as a project of its own is taken off the list
// (its sessions now count here), and one that was a member of another
// project moves. Nothing on disk is touched.
func (s *Service) AddMulti(ctx context.Context, root string, repos []string) (View, bool, error) {
	dir, err := existingDir(root)
	if err != nil {
		return View{}, false, err
	}
	members, err := checkRepos(repos)
	if err != nil {
		return View{}, false, err
	}
	if len(members) < 2 {
		return View{}, false, errors.New("a multi-repo project has at least two repositories; add one repository as a project of its own")
	}
	kind := store.ProjectKindFolder
	if r := store.ResolveRepoRoot(dir); r != "" {
		// The folder is itself a repository: list it as one, as Add does.
		return View{}, false, fmt.Errorf("%s is inside the repository %s; add that repository instead", dir, filepath.FromSlash(r))
	}
	v, created, err := s.insert(ctx, dir, kind, store.ProjectSourceFolder)
	if err != nil {
		return View{}, false, err
	}
	v, err = s.setRepos(ctx, v.ID, members)
	return v, created, err
}

// SetRepos replaces a project's member repositories (the editor's add and
// remove, and Rescan's additions). An empty list makes it an ordinary
// project again; a removed member is neither listed nor deleted.
func (s *Service) SetRepos(ctx context.Context, id int64, repos []string) (View, error) {
	members, err := checkRepos(repos)
	if err != nil {
		return View{}, err
	}
	p, err := store.GetProject(ctx, s.Store.DB(), id)
	if err != nil {
		return View{}, err
	}
	for _, m := range members {
		if m == p.Root {
			return View{}, errors.New("a project's own folder cannot be one of its repositories")
		}
	}
	return s.setRepos(ctx, id, members)
}

// setRepos stores members, absorbs the listed projects whose root is a
// member, and asks git about each member once.
func (s *Service) setRepos(ctx context.Context, id int64, members []string) (View, error) {
	var stored []string
	err := s.Store.WithTx(ctx, func(q store.Querier) error {
		var err error
		stored, err = store.SetProjectRepos(ctx, q, id, members, s.Now().UnixMilli())
		return err
	})
	if err != nil {
		return View{}, err
	}
	s.mu.Lock()
	for pid, ms := range s.members {
		if pid == id {
			continue
		}
		kept := ms[:0]
		for _, m := range ms {
			if !containsString(stored, m) {
				kept = append(kept, m)
			}
		}
		if len(kept) == 0 {
			delete(s.members, pid)
		} else {
			s.members[pid] = kept
		}
	}
	if len(stored) == 0 {
		delete(s.members, id)
	} else {
		s.members[id] = stored
	}
	for _, m := range stored {
		// A session in a member never lists the member on its own.
		s.known[m] = true
	}
	s.mu.Unlock()
	// The member's own project row, if listed, is folded in.
	all, err := store.ListProjects(ctx, s.Store.DB(), false)
	if err == nil {
		for _, lp := range all {
			if lp.ID != id && containsString(stored, lp.Root) {
				if err := s.Unlist(ctx, lp.ID); err != nil {
					s.Log.Warn("could not fold a repository's own project into a multi-repo project", "component", "projects", "id", lp.ID, "err", err)
				}
			}
		}
	}
	for _, m := range stored {
		s.refreshMember(m, 0)
	}
	v, err := s.Get(ctx, id)
	if err == nil && s.Bus != nil {
		s.publish(id)
	}
	return v, err
}

// Split lists each member of a multi-repo project as a project of its own
// (one that was listed before comes back with its old name and settings) and
// takes the multi-repo project off the list. Nothing on disk is touched.
func (s *Service) Split(ctx context.Context, id int64) ([]View, error) {
	members := s.Repos(id)
	if len(members) == 0 {
		return nil, store.ErrNotMultiRepo
	}
	if _, err := s.setRepos(ctx, id, nil); err != nil {
		return nil, err
	}
	out := make([]View, 0, len(members))
	for _, m := range members {
		v, _, err := s.insert(ctx, filepath.FromSlash(m), store.ProjectKindRepo, store.ProjectSourceFolder)
		if err != nil {
			return out, err
		}
		out = append(out, v)
	}
	if err := s.Unlist(ctx, id); err != nil {
		return out, err
	}
	return out, nil
}

// Merge makes one multi-repo project of several projects: their
// repositories (a repository project's root, a multi-repo project's members)
// become the members of one of them — the multi-repo project among them, or
// else a project at the folder that holds them all, which may be neither the
// home folder nor a filesystem root. The others are taken off the list.
func (s *Service) Merge(ctx context.Context, ids []int64) (View, error) {
	if len(ids) < 2 {
		return View{}, errors.New("merge needs two projects or more")
	}
	var target int64
	var repos []string
	seen := map[int64]bool{}
	for _, id := range ids {
		if seen[id] {
			continue
		}
		seen[id] = true
		p, err := store.GetProject(ctx, s.Store.DB(), id)
		if err != nil {
			return View{}, err
		}
		if ms := s.Repos(id); len(ms) > 0 {
			if target != 0 {
				return View{}, errors.New("merge one multi-repo project at a time with repositories")
			}
			target = id
			repos = append(repos, ms...)
			continue
		}
		if p.Kind != store.ProjectKindRepo {
			return View{}, fmt.Errorf("%s is a folder, not a repository; only repositories merge", p.Name)
		}
		repos = append(repos, p.Root)
	}
	repos = store.CleanRepoPaths(repos)
	if target == 0 {
		parent := commonDir(repos)
		if parent == "" || isHomeOrRoot(parent) {
			return View{}, errors.New("these repositories share no folder below your home folder; add the folder that holds them as a project instead")
		}
		v, _, err := s.AddMulti(ctx, filepath.FromSlash(parent), osPaths(repos))
		return v, err
	}
	return s.setRepos(ctx, target, repos)
}

// commonDir is the deepest folder holding every path (normalised form), or "".
func commonDir(paths []string) string {
	if len(paths) == 0 {
		return ""
	}
	parts := strings.Split(paths[0], "/")
	n := len(parts) - 1 // a repository's own folder is not its parent
	for _, p := range paths[1:] {
		ps := strings.Split(p, "/")
		i := 0
		for i < n && i < len(ps)-1 && ps[i] == parts[i] {
			i++
		}
		n = i
	}
	if n <= 0 {
		return ""
	}
	d := strings.Join(parts[:n], "/")
	if d == "" {
		return "/"
	}
	return d
}

// isHomeOrRoot reports a folder an agent should never be started in for a
// merge: the home folder, a filesystem root or a drive.
func isHomeOrRoot(dir string) bool {
	d := store.NormalizeDir(dir)
	if d == "" || d == "/" || (len(d) <= 3 && strings.HasSuffix(strings.TrimSuffix(d, "/"), ":")) {
		return true
	}
	if home, err := os.UserHomeDir(); err == nil && store.NormalizeDir(home) == d {
		return true
	}
	return false
}

func osPaths(ps []string) []string {
	out := make([]string, len(ps))
	for i, p := range ps {
		out[i] = filepath.FromSlash(p)
	}
	return out
}

func containsString(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// OtherRepos is what an agent started in dir is given beside its working
// directory: every member repository of the multi-repo project dir is in,
// except the one dir is inside and those inside dir (already in reach).
// Claude Code gets them as --add-dir (ADR-055). Empty outside a multi-repo
// project.
func (s *Service) OtherRepos(dir string) []string {
	p, ok := s.ProjectFor(dir)
	if !ok {
		return nil
	}
	var out []string
	for _, m := range s.Repos(p.ID) {
		if store.DirWithin(dir, m) || store.DirWithin(m, dir) {
			continue
		}
		mp := filepath.FromSlash(m)
		if st, err := os.Stat(mp); err != nil || !st.IsDir() {
			continue // Claude Code refuses to start on a missing --add-dir
		}
		out = append(out, mp)
	}
	return out
}

// RepoViews is a project's members with their git state and activity, for
// the project page. fresh asks git again about any member whose answer is
// older than memberGitTTL; the frame that follows carries it.
func (s *Service) RepoViews(ctx context.Context, id int64, fresh bool) ([]RepoView, error) {
	v, err := s.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	if fresh {
		now := s.Now()
		s.mu.Lock()
		var stale []string
		for _, m := range s.members[id] {
			g := s.mgit[m]
			if g == nil || (!g.running && now.Sub(g.tried) > memberGitTTL) {
				stale = append(stale, m)
			}
		}
		s.mu.Unlock()
		for _, m := range stale {
			s.refreshMember(m, 0)
		}
	}
	if v.Repos == nil {
		return []RepoView{}, nil
	}
	return v.Repos, nil
}

// refreshMember asks git about a member repository after a delay (0: now,
// in the background) and sends a frame for its project.
func (s *Service) refreshMember(path string, after time.Duration) {
	if s.closed.Load() {
		return
	}
	s.mu.Lock()
	g := s.mgit[path]
	if g == nil {
		g = &memberGit{}
		s.mgit[path] = g
	}
	if after > 0 {
		if g.timer != nil {
			g.timer.Reset(after)
		} else {
			g.timer = time.AfterFunc(after, func() { s.runMember(path) })
		}
		s.mu.Unlock()
		return
	}
	s.mu.Unlock()
	go s.runMember(path)
}

// runMember runs one git status in a member repository.
func (s *Service) runMember(path string) {
	s.life.RLock()
	defer s.life.RUnlock()
	if s.closed.Load() {
		return
	}
	s.mu.Lock()
	g := s.mgit[path]
	if g == nil || g.running {
		s.mu.Unlock()
		return
	}
	g.running, g.timer = true, nil
	g.tried = s.Now()
	prev := g.status
	s.mu.Unlock()

	s.sem <- struct{}{}
	ctx := s.ctx
	if ctx == nil {
		ctx = context.Background()
	}
	dir := filepath.FromSlash(path)
	next := prev
	if gd, ok := findGitDirs(dir); ok {
		next = s.status(ctx, dir, prev)
		next.RemoteURL = readRemoteURL(gd.common)
		next.DefaultBranch = readDefaultBranch(gd.common)
	} else {
		next.Error = "no git repository at " + dir
	}
	<-s.sem

	s.mu.Lock()
	g.status, g.running = next, false
	owner := s.memberOwnerLocked()[path]
	s.mu.Unlock()
	if owner != 0 {
		s.publish(owner)
	}
}

// memberStatus is a member's cached git answer, nil before the first.
func (s *Service) memberStatus(path string) *GitStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	g := s.mgit[path]
	if g == nil || (g.status.At == 0 && g.status.Error == "") {
		return nil
	}
	st := g.status
	return &st
}

// repoViews assembles the members of project p from the git cache and the
// per-member activity.
func (s *Service) repoViews(p store.Project, members []string, act map[string]*store.ProjectActivity) []RepoView {
	out := make([]RepoView, 0, len(members))
	root := filepath.FromSlash(p.Root)
	for _, m := range members {
		mp := filepath.FromSlash(m)
		rv := RepoView{Path: mp, Name: relName(root, mp), Git: s.memberStatus(m)}
		if st, err := os.Stat(mp); err == nil && st.IsDir() {
			rv.Exists = true
		}
		if a := act[m]; a != nil {
			rv.Sessions = Sessions{Live: a.Live, Waiting: a.Waiting, Total: a.Total}
			rv.CostToday, rv.LastActivity = a.CostToday, a.LastActivity
		}
		out = append(out, rv)
	}
	return out
}
