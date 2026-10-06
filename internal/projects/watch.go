package projects

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/fsnotify/fsnotify"

	"github.com/dspv/caprock/internal/store"
	"github.com/dspv/caprock/internal/tcc"
)

// watcher turns changes under each repository's `.git` into debounced
// refreshes. What is watched is what moves the sidebar and nothing else:
// the git dir itself (HEAD, index, packed-refs, FETCH_HEAD, config), the
// branch refs (refs/heads and below) and each linked worktree's own git dir.
// Objects and logs are never watched: they change on every commit and say
// nothing HEAD and the refs do not already say.
type watcher struct {
	s *Service
	w *fsnotify.Watcher

	mu   sync.Mutex
	dirs map[string]watched // watched directory -> whose
}

type watched struct {
	project int64
	common  string // the repository's common git dir
}

func newWatcher(s *Service) (*watcher, error) {
	w, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	return &watcher{s: s, w: w, dirs: map[string]watched{}}, nil
}

// add starts watching a repository project.
func (w *watcher) add(p store.Project) {
	gd, ok := findGitDirs(filepath.FromSlash(p.Root))
	if !ok {
		return
	}
	who := watched{project: p.ID, common: gd.common}
	w.watch(gd.git, who)
	if gd.common != gd.git {
		w.watch(gd.common, who)
	}
	w.watchTree(filepath.Join(gd.common, "refs", "heads"), who)
	w.watch(filepath.Join(gd.common, "worktrees"), who)
	w.addWorktrees(gd.common)
}

// addWorktrees watches every linked worktree's git dir not yet watched.
func (w *watcher) addWorktrees(common string) {
	w.mu.Lock()
	who, ok := w.dirs[filepath.Join(common, "worktrees")]
	if !ok {
		who, ok = w.dirs[common]
	}
	w.mu.Unlock()
	if !ok {
		return
	}
	ents, err := os.ReadDir(filepath.Join(common, "worktrees"))
	if err != nil {
		return
	}
	for _, e := range ents {
		if e.IsDir() {
			w.watch(filepath.Join(common, "worktrees", e.Name()), who)
		}
	}
}

// remove stops watching everything of a project.
func (w *watcher) remove(p store.Project) {
	w.mu.Lock()
	var drop []string
	for d, who := range w.dirs {
		if who.project == p.ID {
			drop = append(drop, d)
		}
	}
	for _, d := range drop {
		delete(w.dirs, d)
	}
	w.mu.Unlock()
	for _, d := range drop {
		_ = w.w.Remove(d)
	}
}

// unwatchTree stops watching dir and everything below it.
func (w *watcher) unwatchTree(dir string) {
	w.mu.Lock()
	var drop []string
	for d := range w.dirs {
		if d == dir || strings.HasPrefix(d, dir+string(filepath.Separator)) {
			drop = append(drop, d)
		}
	}
	for _, d := range drop {
		delete(w.dirs, d)
	}
	w.mu.Unlock()
	for _, d := range drop {
		_ = w.w.Remove(d)
	}
}

func (w *watcher) watch(dir string, who watched) {
	if tcc.OffLimits(dir) {
		return // an isolated daemon (a test, a preview) stays out (ADR-040)
	}
	if tcc.OffLimits(dir) {
		return // an isolated daemon (a test, a preview) stays out (ADR-040)
	}
	w.mu.Lock()
	if _, ok := w.dirs[dir]; ok {
		w.mu.Unlock()
		return
	}
	w.dirs[dir] = who
	w.mu.Unlock()
	if err := w.w.Add(dir); err != nil {
		w.mu.Lock()
		delete(w.dirs, dir)
		w.mu.Unlock()
		if !os.IsNotExist(err) {
			w.s.Log.Warn("cannot watch a repository folder", "component", "projects", "dir", dir, "err", err)
		}
	}
}

// watchTree watches dir and every directory below it (branch names with a
// slash are folders under refs/heads).
func (w *watcher) watchTree(dir string, who watched) {
	if tcc.OffLimits(dir) {
		return
	}
	if tcc.OffLimits(dir) {
		return
	}
	_ = filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			w.watch(p, who)
		}
		return nil
	})
}

func (w *watcher) run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case ev, ok := <-w.w.Events:
			if !ok {
				return
			}
			w.handle(ev)
		case err, ok := <-w.w.Errors:
			if !ok {
				return
			}
			w.s.Log.Warn("repository watcher", "component", "projects", "err", err)
		}
	}
}

// handle maps one change to the project and worktree it belongs to.
func (w *watcher) handle(ev fsnotify.Event) {
	// Chmod alone is an attribute change — a read's access time, a
	// permission bit — never a change to what git would say. Reading the
	// repository (git status does) must not wake the watcher it serves.
	if ev.Op == fsnotify.Chmod {
		return
	}
	name := filepath.Base(ev.Name)
	// A lock file is git about to write; the rename that follows is the
	// change.
	if strings.HasSuffix(name, ".lock") {
		return
	}
	w.mu.Lock()
	who, ok := w.dirs[filepath.Dir(ev.Name)]
	if !ok {
		who, ok = w.dirs[ev.Name]
	}
	w.mu.Unlock()
	if !ok {
		return
	}
	// A new branch folder (feat/…) or a new worktree's git dir: watch it too.
	if ev.Has(fsnotify.Create) {
		if st, err := os.Stat(ev.Name); err == nil && st.IsDir() {
			if strings.HasPrefix(ev.Name, filepath.Join(who.common, "refs")+string(filepath.Separator)) {
				w.watchTree(ev.Name, who)
			} else if filepath.Dir(ev.Name) == filepath.Join(who.common, "worktrees") {
				w.watch(ev.Name, who)
			}
		}
	}
	// Under worktrees/<name>: that worktree changed (or was added or
	// removed), and the main checkout did not.
	wtRoot := filepath.Join(who.common, "worktrees") + string(filepath.Separator)
	if rest, ok := strings.CutPrefix(ev.Name, wtRoot); ok {
		wt, _, _ := strings.Cut(rest, string(filepath.Separator))
		w.s.schedule(who.project, wt, 0)
		return
	}
	w.s.schedule(who.project, "", 0)
}
