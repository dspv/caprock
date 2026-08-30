// Picking a folder without typing its path.
//
// Starting a session meant typing an absolute path into a text field from
// memory — on a dashboard that is already displaying the repositories the
// reader works in every day. The two things that removes the typing are the
// directories they have used before, and a way to walk the one place they keep
// their code.
//
// # Why this is not a file picker
//
// A browser cannot open a native directory chooser without a user gesture that
// grants access to that directory alone, and what the daemon needs is a path
// string it can `cd` into. So the walking happens server-side, which means the
// daemon is being asked to list directories on behalf of a web page — and that
// is the whole security question here.
//
// # What stops this being a filesystem-read API
//
// Three things, in order of how much they matter:
//
//  1. **Only directories, only names.** No file contents, no sizes, no reading
//     of anything. The response is a list of names and whether each holds a
//     git repository.
//  2. **Rooted, and the root is the user's own setting.** Everything is
//     resolved against `BrowseRoot` (default `$HOME`) and a path that escapes
//     it is refused. Symlinks are resolved *before* the check, so a link
//     inside the root pointing out of it does not smuggle a caller past the
//     boundary.
//  3. **Hidden entries stay hidden.** `.ssh`, `.aws`, `.config` are not
//     interesting for picking a repository and are exactly what someone
//     probing would want. `.git` is reported as a *property* of its parent,
//     never as somewhere to descend into.
//
// The CSRF guard in csrf.go already prevents a page on another origin from
// calling this at all; the rules above are what remains true even for a page
// that legitimately can.
package api

import (
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/dspv/caprock/internal/store"
)

// browseEntry is one directory a caller may pick or descend into.
type browseEntry struct {
	Name string `json:"name"`
	Path string `json:"path"`
	// Repo is true when the directory contains a .git — the reader is looking
	// for repositories, and marking them saves opening each one to find out.
	Repo bool `json:"repo"`
}

type browseResponse struct {
	// Dir is the directory that was listed, absolute and resolved.
	Dir string `json:"dir"`
	// Parent is the directory above it, or "" at the root — which is what stops
	// the UI offering an "up" that would be refused.
	Parent string `json:"parent"`
	// Root is the boundary, so the UI can say what it is showing and where the
	// setting that changes it lives.
	Root    string        `json:"root"`
	Entries []browseEntry `json:"entries"`
}

// browseLimit caps one listing. A directory with 40,000 entries is not a
// picker, it is a scroll — and rendering it would cost more than reading it.
const browseLimit = 500

// errOutsideRoot is returned for any path that resolves outside the browse
// root. It is deliberately the same error for "escaped the root" and "does not
// exist", so the response cannot be used to test for the presence of a file
// somewhere the caller is not allowed to look.
var errOutsideRoot = errors.New("path is outside the browsable root")

// browseRoot is the directory everything is resolved against: the user's
// setting when they have one, their home directory otherwise.
func (s *Server) browseRoot() string {
	if s.d.Settings != nil {
		if set := strings.TrimSpace(s.d.Settings.Get().BrowseRoot); set != "" {
			if abs, err := filepath.Abs(set); err == nil {
				if real, err := filepath.EvalSymlinks(abs); err == nil {
					return real
				}
				return abs
			}
		}
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return string(filepath.Separator)
	}
	if real, err := filepath.EvalSymlinks(home); err == nil {
		return real
	}
	return home
}

// resolveInRoot turns a requested path into an absolute one that is provably
// inside root, or returns errOutsideRoot.
//
// Symlinks are resolved first and the containment check is done on the result:
// checking the literal path would let `~/link-to-etc` pass while the listing
// came from somewhere else entirely.
func resolveInRoot(root, req string) (string, error) {
	req = strings.TrimSpace(req)
	if req == "" {
		return root, nil
	}
	// A rooted-but-not-absolute path is refused rather than joined.
	//
	// On Windows `\Windows\System32` has no volume, so filepath.IsAbs reports
	// false — it means "that path on the current drive". Joining it onto the
	// root produced `<root>\Windows\System32`, which is inside the root and so
	// passed every later check: the request escaped nothing, but it was also
	// not the directory anyone asked for. Found by the Windows CI job.
	//
	// Nothing legitimate sends one: the UI only ever echoes paths this endpoint
	// returned, and those are absolute.
	if !filepath.IsAbs(req) {
		if strings.HasPrefix(req, "/") || strings.HasPrefix(req, `\`) {
			return "", errOutsideRoot
		}
		req = filepath.Join(root, req)
	}
	abs, err := filepath.Abs(req)
	if err != nil {
		return "", errOutsideRoot
	}
	// A path that does not exist yet cannot be walked into, and resolving it
	// would fail — so this rejects rather than guessing at the caller's intent.
	real, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return "", errOutsideRoot
	}
	rel, err := filepath.Rel(root, real)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", errOutsideRoot
	}
	return real, nil
}

func (s *Server) handleBrowse(w http.ResponseWriter, r *http.Request) {
	root := s.browseRoot()
	dir, err := resolveInRoot(root, r.URL.Query().Get("dir"))
	if err != nil {
		// 404 rather than 403: a 403 confirms the path exists, which is the one
		// fact a caller probing outside the root would be trying to learn.
		http.Error(w, "not found", http.StatusNotFound)
		return
	}

	des, err := os.ReadDir(dir)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}

	out := make([]browseEntry, 0, len(des))
	for _, de := range des {
		name := de.Name()
		if strings.HasPrefix(name, ".") {
			continue
		}
		// A symlink to a directory is worth offering — a lot of people keep
		// `~/dev/thing` as a link. Stat rather than trusting the dirent type.
		info, err := os.Stat(filepath.Join(dir, name))
		if err != nil || !info.IsDir() {
			continue
		}
		p := filepath.Join(dir, name)
		if _, err := os.Stat(filepath.Join(p, ".git")); err == nil {
			out = append(out, browseEntry{Name: name, Path: p, Repo: true})
			continue
		}
		out = append(out, browseEntry{Name: name, Path: p})
	}

	// Repositories first, then alphabetically: the reader is looking for a
	// repository, so the ones that are already repositories are the answer and
	// the rest are the route to it.
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Repo != out[j].Repo {
			return out[i].Repo
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	truncated := false
	if len(out) > browseLimit {
		out = out[:browseLimit]
		truncated = true
	}

	parent := ""
	if dir != root {
		parent = filepath.Dir(dir)
	}
	resp := browseResponse{Dir: dir, Parent: parent, Root: root, Entries: out}
	if truncated {
		// Said, not silently dropped: a picker that quietly shows 500 of 900
		// folders is a picker that hides the one being looked for.
		w.Header().Set("X-Caprock-Truncated", "1")
	}
	writeJSON(w, http.StatusOK, resp)
}

// recentDir is a directory Caprock has already seen work happen in.
type recentDir struct {
	Dir string `json:"dir"`
	// Name is the last path segment, which is what people call a project.
	Name        string `json:"name"`
	Sessions    int64  `json:"sessions"`
	LastEventAt int64  `json:"last_event_at"`
}

// handleRecentDirs lists the directories sessions have run in, most recent
// first.
//
// This is the half of the picker that needs no browsing at all: the repository
// someone wants next is almost always one they were in yesterday, and the
// daemon already knows every one of them. Unlike /v1/browse this reads the
// database rather than the filesystem, so the root does not apply — these are
// directories the user has demonstrably already worked in.
func (s *Server) handleRecentDirs(w http.ResponseWriter, r *http.Request) {
	dirs, err := store.RecentDirs(r.Context(), s.d.Store.DB(), 8)
	if err != nil {
		s.fail(w, err)
		return
	}
	out := make([]recentDir, 0, len(dirs))
	for _, d := range dirs {
		// A directory that has since been deleted or renamed is not offered:
		// clicking it would spawn a session that fails, and a picker that
		// offers dead paths is worse than a shorter list.
		if fi, err := os.Stat(d.Dir); err != nil || !fi.IsDir() {
			continue
		}
		out = append(out, recentDir{
			Dir:         d.Dir,
			Name:        filepath.Base(d.Dir),
			Sessions:    d.Sessions,
			LastEventAt: d.LastEventAt,
		})
	}
	writeJSON(w, http.StatusOK, out)
}
