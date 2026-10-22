package brain

import (
	"context"
	"path"
	"strings"

	"github.com/dspv/caprock/internal/gitremote"
	"github.com/dspv/caprock/internal/store"
)

// lookupRepo reads a checkout's remote; a variable so a test can stand in.
var lookupRepo = gitremote.Lookup

// memoryProject is the project a session's memories belong to: the
// session's own label, except for a session that ran under the system's
// temp directory. There the label is the throwaway folder's name — a `git
// archive` extracted to `$TMPDIR/ops-seo-site-m143z5ko` made a project of
// that name for every run — so the project is the repository's name from
// its remote when the folder was a checkout with one, and none otherwise:
// the memories are kept, hanging off their topics only.
func memoryProject(ctx context.Context, c store.BrainCandidate) string {
	if c.Cwd == "" || !store.UnderTempDir(c.Cwd) {
		return c.Project
	}
	if c.RepoRoot == "" {
		return ""
	}
	r, ok := lookupRepo(ctx, c.RepoRoot)
	if !ok || r.URL == "" {
		return ""
	}
	name := path.Base(strings.TrimSuffix(r.URL, "/"))
	if name == "." || name == "/" {
		return ""
	}
	return name
}
