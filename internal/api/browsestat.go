package api

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/dspv/caprock/internal/projects"
	"github.com/dspv/caprock/internal/store"
	"github.com/dspv/caprock/internal/tcc"
)

// expandTilde turns a leading ~ into the home folder, as a terminal does, so
// the UI can open the folder browser on a default folder written "~/dev".
// Anything else is returned as it came.
func expandTilde(p string) string {
	p = strings.TrimSpace(p)
	if p != "~" && !strings.HasPrefix(p, "~/") && !strings.HasPrefix(p, `~\`) {
		return p
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return p
	}
	return filepath.Join(home, p[1:])
}

// validDefaultFolder accepts what settings.default_folder may hold: an
// absolute path or one led by ~, on one line, of a sane length.
func validDefaultFolder(v string) bool {
	if strings.ContainsAny(v, "\x00\n\r") || len(v) > 1024 {
		return false
	}
	return filepath.IsAbs(v) || v == "~" || strings.HasPrefix(v, "~/") || strings.HasPrefix(v, `~\`)
}

// statResponse says what a typed path is before anything is done with it:
// the Add project sheet's "exists — not empty, clone will fail", "will be
// created", "already in Caprock".
type statResponse struct {
	// Path is the path that was checked: absolute, ~ expanded, cleaned.
	Path   string `json:"path"`
	Exists bool   `json:"exists"`
	IsDir  bool   `json:"is_dir"`
	// Empty is true for a folder with nothing in it, hidden files included.
	Empty bool `json:"empty"`
	// ParentExists is true when the folder above Path is a folder: one level
	// can be made there (a new project), a deeper chain cannot.
	ParentExists bool `json:"parent_exists"`
	// Guarded is true for a path in a place macOS guards (Documents, Music,
	// a network volume): nothing about it was read, so nothing is said.
	Guarded bool `json:"guarded,omitempty"`
	// ProjectID is the listed project adding Path would return.
	ProjectID   int64  `json:"project_id,omitempty"`
	ProjectName string `json:"project_name,omitempty"`
}

// handleBrowseStat answers GET /v1/browse/stat?path=: whether a path exists,
// is a folder, is empty, and is already a project. It is held to the browse
// rules: the same root, symlinks resolved before the containment check, and
// the same 404 for "outside the root" whether or not the path exists there, so
// it tells a caller nothing the folder browser would not.
func (s *Server) handleBrowseStat(w http.ResponseWriter, r *http.Request) {
	root := s.browseRoot()
	if deviceFrom(r) != nil {
		root = s.deviceBrowseRoot()
	}
	p := expandTilde(r.URL.Query().Get("path"))
	if p == "" || !filepath.IsAbs(p) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	p = filepath.Clean(p)
	// A guarded place is named, never read: a stat inside Documents would ask
	// for Documents while the user types. Inside the root only, or the answer
	// itself would say something about a path outside it.
	if tcc.Guarded(p) {
		if !textuallyWithin(root, p) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		writeJSON(w, http.StatusOK, statResponse{Path: p, Guarded: true})
		return
	}
	// The nearest part of the path that exists must resolve inside the root,
	// so a link inside it cannot make the check report on somewhere else.
	near := p
	for {
		if _, err := os.Lstat(near); err == nil {
			break
		}
		up := filepath.Dir(near)
		if up == near {
			break
		}
		near = up
	}
	if real, err := filepath.EvalSymlinks(near); err != nil || !textuallyWithin(root, real) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	out := statResponse{Path: p}
	if fi, err := os.Stat(filepath.Dir(p)); err == nil && fi.IsDir() {
		out.ParentExists = true
	}
	if near == p {
		// A dangling link exists too: the name is taken.
		out.Exists = true
		if fi, err := os.Stat(p); err == nil && fi.IsDir() {
			out.IsDir = true
			out.Empty = projects.EmptyDir(p)
			if s.d.Projects != nil {
				if pr, ok := s.d.Projects.ListedAt(p); ok {
					out.ProjectID, out.ProjectName = pr.ID, pr.Name
				}
			}
		}
	}
	writeJSON(w, http.StatusOK, out)
}

// junkTempDirs are the temp directories recentJunk leaves out. A variable so
// the tests, whose folders all live in one, can keep them.
var junkTempDirs = store.DefaultTempDirs

// recentJunk is a directory the folder picker's Recent list leaves out
// although sessions ran there: the temp directories (agent scratchpads, test
// runs), Caprock's own data directory (quick chats live in its chats/), and an
// agent's worktree under .claude/worktrees. None of them is somewhere a person
// adds a project or starts work on purpose (owner, 2026-10-09).
func recentJunk(dir, dataDir string) bool {
	for _, t := range junkTempDirs() {
		if store.DirWithin(dir, t) {
			return true
		}
	}
	if dataDir != "" {
		if store.DirWithin(dir, dataDir) {
			return true
		}
		if real, err := filepath.EvalSymlinks(dataDir); err == nil && store.DirWithin(dir, real) {
			return true
		}
	}
	slash := "/" + strings.Trim(filepath.ToSlash(dir), "/") + "/"
	return strings.Contains(slash, "/.claude/worktrees/")
}
