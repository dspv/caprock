// Finding a repository by a few letters of its name.
//
// The New agent sheet asked for a project from a native select, and Add a
// project for a path typed from memory: the owner typed ~/dev/caprock-website
// for ~/dev/caprock-web and was told only "no such folder" (2026-10-10). Both
// sheets now search, and what they search includes the git repositories under
// the default folder — the place the user keeps code — which only the daemon
// can see. The page never walks the disk; it asks this endpoint once and
// filters the answer as the user types.
//
// The same rules as GET /v1/browse hold (browse.go): names and paths only,
// nothing read inside a repository, hidden directories skipped, the scan
// rooted inside the browse root, and places macOS guards never opened.
package api

import (
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/tcc"
)

// repoScanDepth is how far below the default folder a repository is looked
// for: ~/dev/caprock (1) and ~/dev/work/api (2). Deeper is a crawl of
// node_modules and vendored checkouts, not a list of projects.
const repoScanDepth = 2

// repoScanLimit caps one scan's answer, and repoScanVisit the directories it
// may open, so a default folder of / or of a home full of downloads costs a
// bounded amount however it is set.
const (
	repoScanLimit = 1000
	repoScanVisit = 4000
)

// repoScanTTL is how long one scan answers for. A repository cloned a minute
// ago appears on the next open of the sheet after that; nobody waits on a
// rescan, because a stale answer is served while a fresh one is made.
const repoScanTTL = 60 * time.Second

// localRepo is one git repository found on disk.
type localRepo struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

type reposResponse struct {
	// Root is the folder that was scanned: the default folder, ~ expanded,
	// or the browse root when there is none.
	Root string `json:"root"`
	// Home is the user's home folder, so the page can write a path as ~/dev/x
	// the way the user typed it.
	Home      string      `json:"home,omitempty"`
	ScannedAt int64       `json:"scanned_at"`
	Truncated bool        `json:"truncated,omitempty"`
	Repos     []localRepo `json:"repos"`
}

// localRepoCache holds the last scan per root.
type localRepoCache struct {
	mu      sync.Mutex
	entries map[string]*localScan
}

type localScan struct {
	at        time.Time
	repos     []localRepo
	truncated bool
	running   bool
}

// get answers from the cache, rescanning in the background when the answer
// is older than the TTL, and in the foreground only the first time.
func (c *localRepoCache) get(root string, now time.Time) (localScan, bool) {
	c.mu.Lock()
	if c.entries == nil {
		c.entries = map[string]*localScan{}
	}
	e := c.entries[root]
	if e != nil && !e.at.IsZero() {
		snap := *e
		if now.Sub(e.at) > repoScanTTL && !e.running {
			e.running = true
			go c.refresh(root)
		}
		c.mu.Unlock()
		return snap, true
	}
	c.mu.Unlock()
	repos, truncated := scanRepos(root, repoScanDepth)
	c.mu.Lock()
	c.entries[root] = &localScan{at: time.Now(), repos: repos, truncated: truncated}
	snap := *c.entries[root]
	c.mu.Unlock()
	return snap, false
}

func (c *localRepoCache) refresh(root string) {
	repos, truncated := scanRepos(root, repoScanDepth)
	c.mu.Lock()
	c.entries[root] = &localScan{at: time.Now(), repos: repos, truncated: truncated}
	c.mu.Unlock()
}

// scanRepos lists the git repositories at most depth levels below root. A
// repository is not descended into (its submodules and vendored checkouts are
// not projects), hidden directories and node_modules are skipped, and a place
// macOS guards is never opened.
func scanRepos(root string, depth int) ([]localRepo, bool) {
	var out []localRepo
	visited := 0
	truncated := false
	var walk func(dir string, level int)
	walk = func(dir string, level int) {
		if level > depth || truncated {
			return
		}
		if visited >= repoScanVisit {
			truncated = true
			return
		}
		visited++
		des, err := os.ReadDir(dir)
		if err != nil {
			return
		}
		for _, de := range des {
			name := de.Name()
			if strings.HasPrefix(name, ".") || name == "node_modules" {
				continue
			}
			p := filepath.Join(dir, name)
			if tcc.Guarded(p) {
				continue
			}
			// A link to a directory counts, the way ~/dev/thing as a link does
			// in the folder browser; Stat follows it.
			if de.Type()&os.ModeSymlink != 0 {
				if fi, err := os.Stat(p); err != nil || !fi.IsDir() {
					continue
				}
			} else if !de.IsDir() {
				continue
			}
			if _, err := os.Stat(filepath.Join(p, ".git")); err == nil {
				if len(out) >= repoScanLimit {
					truncated = true
					return
				}
				out = append(out, localRepo{Name: name, Path: p})
				continue
			}
			walk(p, level+1)
		}
	}
	walk(root, 1)
	sort.Slice(out, func(i, j int) bool { return strings.ToLower(out[i].Path) < strings.ToLower(out[j].Path) })
	return out, truncated
}

// repoRoot is the folder a scan starts from: the default folder when it is
// set and inside the browse root, otherwise the browse root itself.
func (s *Server) repoRoot(root string) string {
	if s.d.Settings == nil {
		return root
	}
	def := strings.TrimSpace(s.d.Settings.Get().DefaultFolder)
	if def == "" {
		return root
	}
	if dir, err := resolveInRoot(root, expandTilde(def)); err == nil {
		return dir
	}
	return root
}

// handleLocalRepos answers GET /v1/browse/repos: the git repositories under
// the default folder, two levels deep, from a cache the daemon refreshes in
// the background.
func (s *Server) handleLocalRepos(w http.ResponseWriter, r *http.Request) {
	root := s.browseRoot()
	if phoneLimited(r) {
		root = s.deviceBrowseRoot()
	}
	dir := s.repoRoot(root)
	if tcc.Guarded(dir) {
		// Scanning Documents would ask macOS for it on opening a sheet.
		writeJSON(w, http.StatusOK, reposResponse{Root: dir, Home: homeRoot(), Repos: []localRepo{}})
		return
	}
	scan, _ := s.localRepos.get(dir, time.Now())
	repos := scan.repos
	if repos == nil {
		repos = []localRepo{}
	}
	writeJSON(w, http.StatusOK, reposResponse{
		Root: dir, Home: homeRoot(), ScannedAt: scan.at.UnixMilli(), Truncated: scan.truncated, Repos: repos,
	})
}
