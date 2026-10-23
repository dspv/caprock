package brain

import (
	"errors"
	"path/filepath"
	"slices"
	"strings"

	"github.com/dspv/caprock/internal/store"
)

// Excluded folders (Settings → Second Brain, `brain.exclude` in config.json):
// absolute folders whose sessions the extraction never reads. A session is
// excluded when its working directory or its repository root is one of them
// or lies beneath one. The folders' projects are left out of the handoff, the
// current decisions, search and the graph unless that project is opened by
// name, so what was kept before the exclusion stops reaching agents without
// being deleted.

// Limits on the list: a folder is one absolute path on one line.
const (
	ExcludeMax      = 64
	excludeMaxBytes = 1024
)

// ErrExclude is the kind of error CleanExclude returns for a bad entry.
var ErrExclude = errors.New("exclude is a list of absolute folders")

// CleanExclude puts the list into the form it is kept in: each entry trimmed
// and in the store's path form, duplicates and empty lines dropped, the
// order kept. An entry that is not an absolute path, has a line break or a
// NUL, or is over 1,024 bytes, or a list over ExcludeMax entries, is an
// error wrapping ErrExclude.
func CleanExclude(in []string) ([]string, error) {
	if len(in) > ExcludeMax {
		return nil, errors.Join(ErrExclude, errors.New("at most 64 folders"))
	}
	out := make([]string, 0, len(in))
	for _, raw := range in {
		p := strings.TrimSpace(raw)
		if p == "" {
			continue
		}
		if len(p) > excludeMaxBytes || strings.ContainsAny(p, "\n\r\x00") {
			return nil, errors.Join(ErrExclude, errors.New("a folder is one line of at most 1,024 bytes"))
		}
		if !filepath.IsAbs(p) && !strings.HasPrefix(p, "/") {
			return nil, errors.Join(ErrExclude, errors.New(p+" is not an absolute path"))
		}
		p = store.NormalizeDir(p)
		if p == "" || store.NotAProject(p) {
			return nil, errors.Join(ErrExclude, errors.New(raw+" is the root, the home or the temp folder, which hold everything"))
		}
		if !slices.Contains(out, p) {
			out = append(out, p)
		}
	}
	return out, nil
}

// ExcludedFolder is the excluded folder a session falls under — by its
// working directory, else its repository root — and whether there is one.
func ExcludedFolder(exclude []string, cwd, repoRoot string) (string, bool) {
	for _, dir := range exclude {
		if store.UnderDir(cwd, dir) || store.UnderDir(repoRoot, dir) {
			return dir, true
		}
	}
	return "", false
}

// ExcludedProjects are the project labels of the excluded folders, as the
// sessions in them are labelled (store.ProjectFromCwd), without repeats or
// empties: what a graph read, a search, the handoff and the current
// decisions leave out.
func ExcludedProjects(exclude []string) []string {
	var out []string
	for _, dir := range exclude {
		if p := store.ProjectFromCwd(dir); p != "" && !slices.Contains(out, p) {
			out = append(out, p)
		}
	}
	return out
}
