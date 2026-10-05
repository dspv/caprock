// Package projects keeps the list of projects a person works in — added,
// created, cloned, or found from the sessions that ran there — with each
// one's live git state, its worktrees and what its sessions are doing
// (.ai/21-app.md § Projects, WP-05 and WP-08).
//
// Git state is never polled. Each repository's `.git` (HEAD, index, refs,
// worktrees) is watched with fsnotify; a change is debounced and then answered
// by one `git status` under a timeout, with at most two git processes at once.
// An idle machine with fifty projects runs no git at all. The reference app
// ran about 29,000 background git commands in 17 days; this package exists
// partly so that number stays zero when nothing changes.
package projects

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/store"
)

// Defaults for the service's knobs.
const (
	// DefaultDebounce is how long a burst of changes to one `.git` is
	// gathered before git is asked once (21-app.md: 300 ms).
	DefaultDebounce = 300 * time.Millisecond
	// DefaultGitTimeout is how long one git command may take before it is
	// killed and the timeout reported.
	DefaultGitTimeout = 5 * time.Second
	// maxGit is how many git status processes run at once.
	maxGit = 2
	// editDebounce gathers an agent's edits before asking git what changed:
	// edits do not touch `.git`, so without this the changed-files count
	// would wait for the next commit.
	editDebounce = 2 * time.Second
	// activityDebounce gathers session changes before a project frame says
	// how many sessions are live and waiting.
	activityDebounce = time.Second
)

// FrameProject and FrameOp are the live frames this package sends:
// {"type":"project","data":View} and {"type":"op","data":Op}.
const (
	FrameProject bus.FrameType = "project"
	FrameOp      bus.FrameType = "op"
)

// Sessions counts a project's sessions.
type Sessions struct {
	Live    int64 `json:"live"`
	Waiting int64 `json:"waiting"`
	Total   int64 `json:"total"`
}

// View is a project as the API returns it.
type View struct {
	ID       int64           `json:"id"`
	Name     string          `json:"name"`
	Root     string          `json:"root"` // the OS's own form of the path
	Kind     string          `json:"kind"` // repo | folder
	Source   string          `json:"source"`
	Pinned   bool            `json:"pinned"`
	Sort     int64           `json:"sort"`
	AddedAt  int64           `json:"added_at"`
	Archived bool            `json:"archived,omitempty"`
	Exists   bool            `json:"exists"` // the folder is on disk
	Defaults json.RawMessage `json:"defaults"`
	// Git is null for a folder that is not a repository.
	Git          *GitStatus     `json:"git"`
	Sessions     Sessions       `json:"sessions"`
	CostToday    float64        `json:"cost_today"`
	LastActivity int64          `json:"last_activity"`
	Worktrees    []WorktreeView `json:"worktrees"`
	// Removed is set on the frame sent when a project is taken off the list.
	Removed bool `json:"removed,omitempty"`
}

// Service is the projects list and its git watcher.
type Service struct {
	Store *store.Store
	Bus   *bus.Bus
	Log   *slog.Logger
	Now   func() time.Time
	// Eligible decides whether a repository a session ran in is listed
	// without anyone adding it; store.ProjectWorthListing unless a test
	// replaces it.
	Eligible func(root string) bool
	// Env is the environment a clone runs with (the login shell's, so ssh
	// keys and credential helpers are found); os.Environ when nil.
	Env        func() []string
	Debounce   time.Duration
	GitTimeout time.Duration

	sem   chan struct{}
	watch *watcher
	ops   *opRegistry
	ctx   context.Context

	mu       sync.Mutex
	projects map[int64]store.Project // listed projects
	known    map[string]bool         // every root with a row, listed or not, and roots found ineligible
	git      map[int64]*gitState
	timers   map[int64]*time.Timer
	frames   map[int64]*time.Timer
	sessRoot map[string]string // session id -> its directory key, from session frames
	pending  map[string]string // session id -> what its last event asks for ("git", "frame")

	// gitRuns counts git processes started for status; tests read it.
	gitRuns atomic.Int64
	// closed stops refreshes once Close has run; each refresh holds life
	// for reading, so Close returns with no git running in a project's
	// folder.
	closed atomic.Bool
	life   sync.RWMutex
}

type gitState struct {
	status    GitStatus
	worktrees []WorktreeView
	mainStale bool
	wtStale   map[string]bool
	primed    bool
}

// New builds a service; Start brings it up.
func New(st *store.Store, b *bus.Bus, log *slog.Logger) *Service {
	if log == nil {
		log = slog.Default()
	}
	return &Service{Store: st, Bus: b, Log: log, Now: time.Now, Eligible: store.ProjectWorthListing,
		Debounce: DefaultDebounce, GitTimeout: DefaultGitTimeout}
}

func (s *Service) init() {
	if s.Now == nil {
		s.Now = time.Now
	}
	if s.Eligible == nil {
		s.Eligible = store.ProjectWorthListing
	}
	if s.Debounce <= 0 {
		s.Debounce = DefaultDebounce
	}
	if s.GitTimeout <= 0 {
		s.GitTimeout = DefaultGitTimeout
	}
	if s.Log == nil {
		s.Log = slog.Default()
	}
	s.sem = make(chan struct{}, maxGit)
	s.ops = newOpRegistry()
	s.projects = map[int64]store.Project{}
	s.known = map[string]bool{}
	s.git = map[int64]*gitState{}
	s.timers = map[int64]*time.Timer{}
	s.frames = map[int64]*time.Timer{}
	s.sessRoot = map[string]string{}
	s.pending = map[string]string{}
}

// Start seeds the list on first run, starts watching every listed
// repository, asks git once about each, and follows the bus for sessions in
// folders not yet listed. It returns once the list is loaded; git answers
// arrive as project frames.
func (s *Service) Start(ctx context.Context) error {
	s.init()
	s.ctx = ctx
	if err := s.seed(ctx); err != nil {
		s.Log.Warn("could not seed the projects list", "component", "projects", "err", err)
	}
	w, err := newWatcher(s)
	if err != nil {
		// Without a watcher git state is still right when asked (GET primes
		// it) but goes stale between asks; say so rather than poll.
		s.Log.Warn("cannot watch repositories; git state will refresh only when a project changes here", "component", "projects", "err", err)
	} else {
		s.watch = w
		go w.run(ctx)
	}
	all, err := store.ListProjects(ctx, s.Store.DB(), true)
	if err != nil {
		return err
	}
	for _, p := range all {
		s.mu.Lock()
		s.known[p.Root] = true
		s.mu.Unlock()
		if p.ArchivedAt == 0 {
			s.track(p)
		}
	}
	if s.Bus != nil {
		go s.follow(ctx, s.Bus.Subscribe(4096))
	}
	go func() {
		<-ctx.Done()
		s.Close()
	}()
	return nil
}

// Close stops watching and asking git, and returns once no refresh is
// running. Safe to call more than once.
func (s *Service) Close() {
	if !s.closed.CompareAndSwap(false, true) {
		return
	}
	s.mu.Lock()
	for id, t := range s.timers {
		t.Stop()
		delete(s.timers, id)
	}
	for id, t := range s.frames {
		t.Stop()
		delete(s.frames, id)
	}
	s.mu.Unlock()
	if s.watch != nil {
		_ = s.watch.w.Close()
	}
	s.life.Lock()
	defer s.life.Unlock()
}

// seed lists, once, the repositories sessions have run in.
func (s *Service) seed(ctx context.Context) error {
	if v, _ := s.Store.GetMeta(ctx, store.MetaProjectsSeeded); v == "1" {
		return nil
	}
	roots, err := store.SessionRepoRoots(ctx, s.Store.DB())
	if err != nil {
		return err
	}
	n := 0
	seen := map[string]bool{}
	for _, r := range roots {
		if !s.Eligible(r.Dir) {
			continue
		}
		// One folder reached by two spellings (/var and /private/var on
		// macOS, a symlinked ~/dev) is one project: the most recent wins.
		real := r.Dir
		if rp, err := filepath.EvalSymlinks(filepath.FromSlash(r.Dir)); err == nil {
			real = rp
		}
		if seen[real] {
			continue
		}
		seen[real] = true
		added, err := store.SeedProject(ctx, s.Store.DB(), store.Project{
			Root: r.Dir, Name: baseName(r.Dir), Kind: store.ProjectKindRepo, Source: store.ProjectSourceSeed, AddedAt: s.Now().UnixMilli(),
		})
		if err != nil {
			return err
		}
		if added {
			n++
		}
	}
	s.Log.Info("seeded the projects list from sessions", "component", "projects", "added", n)
	return s.Store.SetMeta(ctx, store.MetaProjectsSeeded, "1")
}

// track starts keeping a listed project's git state.
func (s *Service) track(p store.Project) {
	s.mu.Lock()
	s.projects[p.ID] = p
	s.known[p.Root] = true
	if _, ok := s.git[p.ID]; !ok && p.Kind == store.ProjectKindRepo {
		s.git[p.ID] = &gitState{mainStale: true, wtStale: map[string]bool{}}
	}
	s.mu.Unlock()
	if p.Kind != store.ProjectKindRepo {
		return
	}
	if s.watch != nil {
		s.watch.add(p)
	}
	s.schedule(p.ID, "", 0)
}

// untrack stops watching a project.
func (s *Service) untrack(id int64) {
	s.mu.Lock()
	p, ok := s.projects[id]
	delete(s.projects, id)
	delete(s.git, id)
	if t := s.timers[id]; t != nil {
		t.Stop()
		delete(s.timers, id)
	}
	s.mu.Unlock()
	if ok && s.watch != nil {
		s.watch.remove(p)
	}
}

// List returns every listed project with its git state and activity.
func (s *Service) List(ctx context.Context) ([]View, error) {
	ps, err := store.ListProjects(ctx, s.Store.DB(), false)
	if err != nil {
		return nil, err
	}
	act, err := s.activity(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]View, 0, len(ps))
	for _, p := range ps {
		out = append(out, s.view(p, act))
	}
	return out, nil
}

// Get returns one project, archived or not.
func (s *Service) Get(ctx context.Context, id int64) (View, error) {
	p, err := store.GetProject(ctx, s.Store.DB(), id)
	if err != nil {
		return View{}, err
	}
	act, err := s.activity(ctx)
	if err != nil {
		return View{}, err
	}
	return s.view(p, act), nil
}

// activity is each project's sessions and spend, keyed by project id.
func (s *Service) activity(ctx context.Context) (map[int64]*store.ProjectActivity, error) {
	now := s.Now()
	y, m, d := now.Date()
	midnight := time.Date(y, m, d, 0, 0, 0, 0, now.Location()).UnixMilli()
	byDir, err := store.ProjectActivityByDir(ctx, s.Store.DB(), midnight)
	if err != nil {
		return nil, err
	}
	ps, err := store.ListProjects(ctx, s.Store.DB(), true)
	if err != nil {
		return nil, err
	}
	out := map[int64]*store.ProjectActivity{}
	for dir, a := range byDir {
		best, bestLen := int64(0), -1
		for _, p := range ps {
			if len(p.Root) > bestLen && store.DirWithin(dir, p.Root) {
				best, bestLen = p.ID, len(p.Root)
			}
		}
		if bestLen < 0 {
			continue
		}
		t, ok := out[best]
		if !ok {
			t = &store.ProjectActivity{}
			out[best] = t
		}
		t.Total += a.Total
		t.Live += a.Live
		t.Waiting += a.Waiting
		t.CostToday += a.CostToday
		if a.LastActivity > t.LastActivity {
			t.LastActivity = a.LastActivity
		}
	}
	return out, nil
}

// view assembles a project's View from its row, the git cache and activity.
func (s *Service) view(p store.Project, act map[int64]*store.ProjectActivity) View {
	root := filepath.FromSlash(p.Root)
	v := View{ID: p.ID, Name: p.Name, Root: root, Kind: p.Kind, Source: p.Source, Pinned: p.Pinned, Sort: p.Sort,
		AddedAt: p.AddedAt, Archived: p.ArchivedAt != 0, Defaults: json.RawMessage(p.Defaults), Worktrees: []WorktreeView{}}
	if len(v.Defaults) == 0 || !json.Valid(v.Defaults) {
		v.Defaults = json.RawMessage("{}")
	}
	if st, err := os.Stat(root); err == nil && st.IsDir() {
		v.Exists = true
	}
	if a := act[p.ID]; a != nil {
		v.Sessions = Sessions{Live: a.Live, Waiting: a.Waiting, Total: a.Total}
		v.CostToday, v.LastActivity = a.CostToday, a.LastActivity
	}
	if p.Kind != store.ProjectKindRepo {
		return v
	}
	s.mu.Lock()
	g := s.git[p.ID]
	if g != nil {
		st := g.status
		v.Git = &st
		v.Worktrees = append(v.Worktrees, g.worktrees...)
	}
	s.mu.Unlock()
	if v.Git == nil {
		v.Git = &GitStatus{RemoteURL: p.RemoteURL, DefaultBranch: p.DefaultBranch}
	}
	return v
}

// publish sends a project's current view as a frame.
func (s *Service) publish(id int64) {
	if s.Bus == nil {
		return
	}
	ctx := context.Background()
	v, err := s.Get(ctx, id)
	if err != nil {
		return
	}
	s.Bus.Publish(bus.Frame{Type: FrameProject, Data: v})
}

// Add lists an existing folder. A folder inside a repository lists the
// repository, so its git state and its sessions are one row. Adding a folder
// already listed returns it; one that was unlisted is listed again.
func (s *Service) Add(ctx context.Context, path string) (View, bool, error) {
	dir, err := existingDir(path)
	if err != nil {
		return View{}, false, err
	}
	kind, root := store.ProjectKindFolder, dir
	if r := store.ResolveRepoRoot(dir); r != "" {
		kind, root = store.ProjectKindRepo, filepath.FromSlash(r)
	}
	return s.insert(ctx, root, kind, store.ProjectSourceFolder)
}

// Create makes a new folder name under parent, runs `git init` in it when
// gitInit, and lists it. parent must exist; one level is made, never a chain.
func (s *Service) Create(ctx context.Context, parent, name string, gitInit bool) (View, error) {
	dir, err := newChildDir(parent, name)
	if err != nil {
		return View{}, err
	}
	if err := os.Mkdir(dir, 0o755); err != nil {
		if os.IsExist(err) {
			return View{}, fmt.Errorf("%s already exists; add it instead", dir)
		}
		return View{}, fmt.Errorf("could not create %s: %w", dir, err)
	}
	kind := store.ProjectKindFolder
	if gitInit {
		if _, err := runGit(ctx, 30*time.Second, dir, "init", "-q"); err != nil {
			return View{}, fmt.Errorf("git init in %s: %w", dir, err)
		}
		kind = store.ProjectKindRepo
	}
	v, _, err := s.insert(ctx, dir, kind, store.ProjectSourceNew)
	return v, err
}

// sameAsListed finds a project row for the folder root names under another
// spelling (a symlink), listed or not.
func (s *Service) sameAsListed(ctx context.Context, root string) (store.Project, bool) {
	all, err := store.ListProjects(ctx, s.Store.DB(), true)
	if err != nil {
		return store.Project{}, false
	}
	for _, p := range all {
		if sameFolder(filepath.FromSlash(p.Root), root) {
			return p, true
		}
	}
	return store.Project{}, false
}

// insert adds or relists a project at root and starts tracking it.
func (s *Service) insert(ctx context.Context, root, kind, source string) (View, bool, error) {
	if p, ok := s.sameAsListed(ctx, root); ok {
		root = filepath.FromSlash(p.Root)
	}
	p, created, err := store.InsertProject(ctx, s.Store.DB(), store.Project{
		Root: root, Name: baseName(root), Kind: kind, Source: source, AddedAt: s.Now().UnixMilli(),
	})
	if err != nil {
		return View{}, false, err
	}
	s.track(p)
	v, err := s.Get(ctx, p.ID)
	if err == nil && s.Bus != nil {
		s.Bus.Publish(bus.Frame{Type: FrameProject, Data: v})
	}
	return v, created, err
}

// Patch is what may be changed on a project.
type Patch struct {
	Name     *string          `json:"name,omitempty"`
	Pinned   *bool            `json:"pinned,omitempty"`
	Sort     *int64           `json:"sort,omitempty"`
	Defaults *json.RawMessage `json:"defaults,omitempty"`
}

// Update applies a patch and returns the project after it.
func (s *Service) Update(ctx context.Context, id int64, patch Patch) (View, error) {
	sp := store.ProjectPatch{Pinned: patch.Pinned, Sort: patch.Sort}
	if patch.Name != nil {
		n := strings.TrimSpace(*patch.Name)
		if n == "" || len(n) > 200 || strings.ContainsAny(n, "\x00\r\n") {
			return View{}, errors.New("a name is 1 to 200 characters on one line")
		}
		sp.Name = &n
	}
	if patch.Defaults != nil {
		d, err := checkDefaults(*patch.Defaults)
		if err != nil {
			return View{}, err
		}
		sp.Defaults = &d
	}
	if err := store.UpdateProject(ctx, s.Store.DB(), id, sp); err != nil {
		return View{}, err
	}
	if p, err := store.GetProject(ctx, s.Store.DB(), id); err == nil && p.ArchivedAt == 0 {
		s.mu.Lock()
		s.projects[id] = p
		s.mu.Unlock()
	}
	v, err := s.Get(ctx, id)
	if err == nil && s.Bus != nil {
		s.Bus.Publish(bus.Frame{Type: FrameProject, Data: v})
	}
	return v, err
}

// Unlist takes a project off the list. Nothing on disk is touched, and the
// sessions that ran there keep their cost and history.
func (s *Service) Unlist(ctx context.Context, id int64) error {
	if err := store.ArchiveProject(ctx, s.Store.DB(), id, s.Now().UnixMilli()); err != nil {
		return err
	}
	s.untrack(id)
	if s.Bus != nil {
		s.Bus.Publish(bus.Frame{Type: FrameProject, Data: View{ID: id, Removed: true, Defaults: json.RawMessage("{}"), Worktrees: []WorktreeView{}}})
	}
	return nil
}

// Worktrees lists a project's linked worktrees, from the git cache.
func (s *Service) Worktrees(ctx context.Context, id int64) ([]WorktreeView, error) {
	v, err := s.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	if v.Kind != store.ProjectKindRepo {
		return nil, errors.New("this project is not a git repository")
	}
	return v.Worktrees, nil
}

// AddWorktree creates a worktree on any branch and returns it.
func (s *Service) AddWorktree(ctx context.Context, id int64, spec agents.WorktreeSpec) (agents.Worktree, error) {
	p, err := store.GetProject(ctx, s.Store.DB(), id)
	if err != nil {
		return agents.Worktree{}, err
	}
	if p.Kind != store.ProjectKindRepo {
		return agents.Worktree{}, errors.New("this project is not a git repository")
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	wt, err := agents.AddWorktree(ctx, filepath.FromSlash(p.Root), spec)
	if err != nil {
		return agents.Worktree{}, err
	}
	s.refreshNow(id)
	return wt, nil
}

// RemoveWorktree removes a clean worktree Caprock made. Anything else is
// refused with the reason.
func (s *Service) RemoveWorktree(ctx context.Context, id int64, name string) error {
	p, err := store.GetProject(ctx, s.Store.DB(), id)
	if err != nil {
		return err
	}
	if p.Kind != store.ProjectKindRepo {
		return errors.New("this project is not a git repository")
	}
	if s.watch != nil {
		// Windows will not remove a directory something holds open.
		if gd, ok := findGitDirs(filepath.FromSlash(p.Root)); ok {
			s.watch.unwatchTree(filepath.Join(gd.common, "worktrees", name))
		}
	}
	ctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	err = agents.RemoveWorktree(ctx, filepath.FromSlash(p.Root), name)
	s.refreshNow(id)
	return err
}

// refreshNow asks git about a project at once (after something this service
// did itself), and sends the frame.
func (s *Service) refreshNow(id int64) {
	s.mu.Lock()
	if g := s.git[id]; g != nil {
		g.mainStale = true
		for _, w := range g.worktrees {
			g.wtStale[w.Name] = true
		}
		g.wtStale["*"] = true
	}
	s.mu.Unlock()
	s.refresh(id)
}

// schedule marks part of a project stale and asks git after the debounce:
// the main checkout when wt is "", else the linked worktree named wt.
func (s *Service) schedule(id int64, wt string, after time.Duration) {
	if after <= 0 {
		after = s.Debounce
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	g := s.git[id]
	if g == nil || s.closed.Load() {
		return
	}
	if wt == "" {
		g.mainStale = true
	} else {
		g.wtStale[wt] = true
	}
	if t := s.timers[id]; t != nil {
		t.Reset(after)
		return
	}
	s.timers[id] = time.AfterFunc(after, func() { s.refresh(id) })
}

// refresh asks git what is stale about a project and sends a frame.
func (s *Service) refresh(id int64) {
	s.life.RLock()
	defer s.life.RUnlock()
	if s.closed.Load() {
		return
	}
	s.mu.Lock()
	// A change from here on schedules a refresh of its own.
	delete(s.timers, id)
	p, ok := s.projects[id]
	g := s.git[id]
	if !ok || g == nil {
		s.mu.Unlock()
		return
	}
	main, wts := g.mainStale, g.wtStale
	all := !g.primed || wts["*"]
	g.mainStale, g.wtStale = false, map[string]bool{}
	s.mu.Unlock()

	s.sem <- struct{}{}
	defer func() { <-s.sem }()
	ctx := s.ctx
	if ctx == nil {
		ctx = context.Background()
	}
	root := filepath.FromSlash(p.Root)
	gd, found := findGitDirs(root)
	next := GitStatus{}
	s.mu.Lock()
	prev := g.status
	prevWts := append([]WorktreeView(nil), g.worktrees...)
	s.mu.Unlock()
	if !found {
		next = prev
		next.Error = "no git repository at " + root
	} else {
		next = prev
		if main || all || prev.At == 0 {
			next = s.status(ctx, root, prev)
		}
		next.RemoteURL = readRemoteURL(gd.common)
		next.DefaultBranch = readDefaultBranch(gd.common)
	}
	var worktrees []WorktreeView
	if found {
		worktrees = readWorktrees(gd.common, filepath.Join(root, agents.WorktreeDir))
		old := map[string]WorktreeView{}
		for _, w := range prevWts {
			old[w.Name] = w
		}
		for i, w := range worktrees {
			o, had := old[w.Name]
			if w.Missing {
				continue
			}
			if had && !all && !wts[w.Name] && o.Path == w.Path {
				worktrees[i].Dirty, worktrees[i].Changed, worktrees[i].Error = o.Dirty, o.Changed, o.Error
				continue
			}
			st := s.status(ctx, w.Path, GitStatus{})
			worktrees[i].Dirty, worktrees[i].Changed, worktrees[i].Error = st.Dirty, st.Changed, st.Error
		}
		if s.watch != nil {
			s.watch.addWorktrees(gd.common)
		}
	}
	s.mu.Lock()
	if g2 := s.git[id]; g2 == g {
		g.status, g.worktrees, g.primed = next, worktrees, true
	}
	s.mu.Unlock()
	if found && (next.RemoteURL != p.RemoteURL || next.DefaultBranch != p.DefaultBranch) {
		_ = store.SetProjectGit(ctx, s.Store.DB(), id, next.RemoteURL, next.DefaultBranch)
		p.RemoteURL, p.DefaultBranch = next.RemoteURL, next.DefaultBranch
		s.mu.Lock()
		if _, ok := s.projects[id]; ok {
			s.projects[id] = p
		}
		s.mu.Unlock()
	}
	s.publish(id)
}

// status runs one `git status` in dir; on failure it keeps prev's figures
// and says why.
func (s *Service) status(ctx context.Context, dir string, prev GitStatus) GitStatus {
	s.gitRuns.Add(1)
	out, err := runGit(ctx, s.GitTimeout, dir, "status", "--porcelain=v2", "--branch")
	if err != nil {
		prev.Error = err.Error()
		s.Log.Warn("git status failed", "component", "projects", "dir", dir, "err", err)
		return prev
	}
	g := parseStatus(out)
	g.At = s.Now().UnixMilli()
	return g
}

// GitRuns is how many git status processes this service has started.
func (s *Service) GitRuns() int64 { return s.gitRuns.Load() }

// ProjectFor is the listed project dir lies in (the longest root that holds
// it), or false.
func (s *Service) ProjectFor(dir string) (store.Project, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var best store.Project
	found := false
	for _, p := range s.projects {
		if store.DirWithin(dir, p.Root) && (!found || len(p.Root) > len(best.Root)) {
			best, found = p, true
		}
	}
	return best, found
}

// Project returns a listed project's row.
func (s *Service) Project(id int64) (store.Project, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.projects[id]
	return p, ok
}

// existingDir checks that path is an absolute directory and returns it clean.
func existingDir(path string) (string, error) {
	if path == "" || !filepath.IsAbs(path) {
		return "", fmt.Errorf("%q is not an absolute path", path)
	}
	dir := filepath.Clean(path)
	st, err := os.Stat(dir)
	if err != nil || !st.IsDir() {
		return "", fmt.Errorf("%s is not a folder", dir)
	}
	return dir, nil
}

// newChildDir is parent/name after checking both: parent an existing
// absolute folder, name one plain path segment.
func newChildDir(parent, name string) (string, error) {
	p, err := existingDir(parent)
	if err != nil {
		return "", err
	}
	if err := checkFolderName(name); err != nil {
		return "", err
	}
	return filepath.Join(p, name), nil
}

// checkFolderName refuses anything that is not one ordinary folder name.
func checkFolderName(name string) error {
	if name == "" || name == "." || name == ".." || len(name) > 255 || strings.ContainsAny(name, `/\:*?"<>|`) {
		return fmt.Errorf("%q is not a folder name", name)
	}
	for _, r := range name {
		if r < 0x20 || r == 0x7f {
			return fmt.Errorf("%q is not a folder name", name)
		}
	}
	return nil
}

// checkDefaults accepts {agent?, model?, permission_mode?} with string
// values, and returns it compacted.
func checkDefaults(raw json.RawMessage) (string, error) {
	var d struct {
		Agent          string `json:"agent,omitempty"`
		Model          string `json:"model,omitempty"`
		PermissionMode string `json:"permission_mode,omitempty"`
	}
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&d); err != nil {
		return "", errors.New("defaults is {agent?, model?, permission_mode?}, each a string")
	}
	if d.Agent != "" && !agents.IsSpawnable(d.Agent) {
		return "", fmt.Errorf("caprock cannot start %q sessions", d.Agent)
	}
	b, _ := json.Marshal(d)
	return string(b), nil
}

// baseName is the last segment of a path, in either separator.
func baseName(p string) string {
	p = strings.TrimRight(filepath.ToSlash(p), "/")
	if i := strings.LastIndexByte(p, '/'); i >= 0 {
		return p[i+1:]
	}
	return p
}
