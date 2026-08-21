package store

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

// Repository grouping — why the row is the repo, not the basename.
//
// The Projects panel used to label a session by the BASENAME of its cwd, so one
// repository showed up as several rows (`caprock` and `ui`), a subdirectory
// posed as a project (`app` under amarketer), Caprock's own agent worktrees
// became projects (`worker-1`), and — worst, because it is silently wrong
// rather than merely ugly — two unrelated absolute paths ending in the same
// segment summed into one row (two `testrepo`s, two `repo`s on the owner's real
// database).
//
// So the label is derived in two levels: the repository root a cwd belongs to
// (the row), and the path within it (the expandable breakdown).
//
// RESOLUTION STRATEGY. The root is found by walking up for `.git` — but the
// walk is only ever done at ingest, once per distinct cwd, behind a cache, and
// the answer is PERSISTED on the sessions row (see migration 0011). Three
// reasons this beats deriving on read:
//
//   - Historical sessions point at directories that may no longer exist (the
//     owner's database is full of scratchpad paths that are already gone). A
//     read-time walk answers "no repo" for them, so yesterday's spend would
//     change label depending on what is still on disk today.
//   - /v1/stats/summary is polled on an interval. A filesystem walk per session
//     row inside that query is a syscall storm on the hot path.
//   - A resolved root is a fact about the session, like its branch — it belongs
//     next to the cwd it describes.
//
// When the directory is gone (or was never a repo), resolution degrades to a
// pure-string heuristic that never touches the filesystem, so every row still
// gets a stable, collision-free label without inventing a repository.

// RepoInfo is the two-level project identity of a working directory.
type RepoInfo struct {
	// Root is the absolute repository root, or "" when the cwd is not inside a
	// repository.
	Root string
	// Repo is the display label for the repository row.
	Repo string
	// Path is the location within the repository, "" for the repository root
	// itself. Always slash-separated, whatever the host's separator.
	Path string
}

// Segment returns the row label for the breakdown inside a repository: the
// directory path under the root, written from the root so it reads as a path
// rather than a name — "/", "/ui", "/ui/src". Collapsing to the first segment
// was the first version and hid the distinction the breakdown exists to show:
// in a monorepo, "/services/api" and "/services/web" are the two rows anyone
// opening this actually wants.
func (r RepoInfo) Segment() string {
	if r.Path == "" {
		return "/"
	}
	return "/" + r.Path
}

// repoCache memoises the filesystem walk. Sessions arrive in bursts from a
// handful of directories, so this turns a per-event walk into a per-directory
// one.
var repoCache sync.Map // cwd string -> RepoInfo

// RepoFromCwd resolves the repository a working directory belongs to.
//
// It walks up from cwd looking for `.git`. A `.git` DIRECTORY is an ordinary
// clone. A `.git` FILE is a linked worktree — including the `.caprock-worktrees/
// worker-N` trees Caprock creates for its own agents — and its `gitdir:` line
// points into `<parent>/.git/worktrees/<name>`, so the parent repository is
// recovered from it and the worker's spend lands on the repository it is
// actually working on, which is the whole point of a worktree.
//
// A cwd with no repository above it (/tmp, a scratchpad) is labelled from the
// path itself, never given a fabricated repository name.
func RepoFromCwd(cwd string) RepoInfo {
	cwd = normalizeCwd(cwd)
	if cwd == "" {
		return RepoInfo{}
	}
	if v, ok := repoCache.Load(cwd); ok {
		return v.(RepoInfo)
	}
	info := resolveRepo(cwd)
	repoCache.Store(cwd, info)
	return info
}

func resolveRepo(cwd string) RepoInfo {
	if root, ok := findRepoRoot(cwd); ok {
		info := repoInfoFor(root, cwd)
		// A linked worktree resolves to the repository that owns it, and its
		// checkout directory is not a place in that repository's tree — the
		// worker is editing the SAME files as the root, on another branch. So
		// its spend belongs to the repository root, not to a directory that
		// exists only as plumbing. Caprock puts its own agents' worktrees at
		// `<repo>/.caprock-worktrees/<worker>`, i.e. INSIDE the repository, so
		// the containment check alone does not catch them and the segment is
		// stripped by name. Without this, Caprock's own agents invent a
		// subdirectory nobody has ever navigated to.
		if info.Root != "" && !hasPathPrefix(cwd, info.Root) {
			info.Path = ""
		}
		info.Path = stripWorktreeSegment(info.Path)
		return info
	}
	return unrootedInfo(cwd)
}

// WorktreeDir is where Caprock checks out a worktree for one of its own agents,
// relative to the repository root. Kept here so the resolver and the code that
// creates them agree on the name (see internal/agents.WorktreeDir).
const WorktreeDir = ".caprock-worktrees"

// stripWorktreeSegment removes a leading `.caprock-worktrees/<worker>` from a
// path within a repository, so an agent's work reads as the repository itself.
func stripWorktreeSegment(path string) string {
	if path == "" || !strings.HasPrefix(path, WorktreeDir) {
		return path
	}
	rest := strings.TrimPrefix(path, WorktreeDir)
	if rest == "" {
		return "" // the container directory itself
	}
	if rest[0] != '/' {
		return path // a different directory that merely starts with the name
	}
	rest = strings.TrimLeft(rest, "/")
	// Drop the worker's own directory name; anything below it is a real path
	// inside the checkout and keeps its meaning.
	if i := strings.IndexByte(rest, '/'); i >= 0 {
		return rest[i+1:]
	}
	return ""
}

// maxWalkUp bounds the upward walk. A repository root above this many levels is
// not worth a syscall per level on an ingest path; the string fallback still
// labels the session.
const maxWalkUp = 40

// findRepoRoot walks up from dir for a `.git` entry, resolving a linked
// worktree to the repository that owns it.
func findRepoRoot(dir string) (string, bool) {
	for i := 0; i < maxWalkUp; i++ {
		st, err := os.Stat(filepath.Join(dir, ".git"))
		switch {
		case err == nil && st.IsDir():
			return dir, true
		case err == nil:
			// `.git` is a file: a linked worktree (or a submodule). Follow it.
			if parent, ok := parentOfWorktree(filepath.Join(dir, ".git")); ok {
				return parent, true
			}
			// A `gitdir:` we cannot interpret still marks a repository boundary
			// — treating dir as its own root beats walking past it into an
			// unrelated parent.
			return dir, true
		}
		next := filepath.Dir(dir)
		if next == dir {
			return "", false
		}
		dir = next
	}
	return "", false
}

// parentOfWorktree reads a `.git` file and returns the repository that owns the
// linked worktree it points at.
//
// The file holds `gitdir: <path>/.git/worktrees/<name>`; the repository root is
// the directory holding that `.git`. A submodule's `.git` file points at
// `<super>/.git/modules/<name>` instead — that is a repository in its own right
// and deliberately does NOT collapse into the superproject, so this only
// unwraps the `worktrees` form.
func parentOfWorktree(gitFile string) (string, bool) {
	b, err := os.ReadFile(gitFile)
	if err != nil {
		return "", false
	}
	line := strings.TrimSpace(string(b))
	const prefix = "gitdir:"
	if !strings.HasPrefix(line, prefix) {
		return "", false
	}
	gitDir := strings.TrimSpace(strings.TrimPrefix(line, prefix))
	if gitDir == "" {
		return "", false
	}
	// The pointer may be relative to the worktree that holds the `.git` file.
	if !filepath.IsAbs(gitDir) {
		gitDir = filepath.Join(filepath.Dir(gitFile), gitDir)
	}
	gitDir = filepath.Clean(gitDir)
	// Expect .../<root>/.git/worktrees/<name> — climb the two known levels and
	// verify we landed on a `.git`, so a differently-shaped path is refused
	// rather than mis-parsed into some unrelated ancestor.
	worktreesDir := filepath.Dir(gitDir) // .../.git/worktrees
	if filepath.Base(worktreesDir) != "worktrees" {
		return "", false
	}
	dotGit := filepath.Dir(worktreesDir) // .../.git
	if filepath.Base(dotGit) != ".git" {
		return "", false
	}
	root := filepath.Dir(dotGit)
	if root == "" || root == dotGit {
		return "", false
	}
	return normalizeCwd(root), true
}

// repoInfoFor builds the two-level identity from a resolved root and a cwd
// inside it.
func repoInfoFor(root, cwd string) RepoInfo {
	root = normalizeCwd(root)
	info := RepoInfo{Root: root, Repo: repoLabel(root)}
	info.Path = relativeUnder(root, cwd)
	return info
}

// relativeUnder returns cwd expressed relative to root, slash-separated, or ""
// when they are the same directory. A cwd that is not actually under root
// yields "" rather than a `..` path.
func relativeUnder(root, cwd string) string {
	if pathEqual(root, cwd) {
		return ""
	}
	if !hasPathPrefix(cwd, root) {
		return ""
	}
	rest := cwd[len(root):]
	rest = strings.TrimLeft(rest, "/")
	return rest
}

// repoLabel is the display name of a repository root: its basename.
//
// The basename alone is what a person calls their repository, so it is the
// label — but it is NOT the identity. Two checkouts can share a basename
// (`livegraph/repo` and `orch-live/repo` both exist on the owner's machine),
// and summing them into one row is precisely the bug this change exists to
// fix. Disambiguation therefore happens on the identity, not here: rows are
// grouped by repo_root, and DisambiguateLabels adds parent segments to the few
// labels that would otherwise read the same.
func repoLabel(root string) string {
	root = normalizeCwd(root)
	if root == "" {
		return ""
	}
	base := lastSegment(root)
	if base == "" {
		// A filesystem or drive root: use what we have rather than an empty label.
		return strings.TrimSuffix(root, "/")
	}
	return base
}

// DisambiguateLabels resolves collisions among repository labels within one
// result set: two distinct roots whose basename is the same each grow parent
// segments until they read differently (`livegraph/repo`, `orch-live/repo`).
//
// This runs over a summary's rows rather than at ingest, because whether a
// label is ambiguous is a property of the set it is displayed in, not of the
// repository. A label that is unique — the overwhelming majority — is left
// exactly as the user would say it.
//
// roots maps each row's label to its repository root; the returned map gives
// the label to display for each root.
func DisambiguateLabels(roots map[string]string) map[string]string {
	// Group roots by the label they currently claim.
	byLabel := map[string][]string{}
	for root, label := range roots {
		byLabel[label] = append(byLabel[label], root)
	}
	out := make(map[string]string, len(roots))
	for label, group := range byLabel {
		if len(group) < 2 || label == "" {
			for _, root := range group {
				out[root] = label
			}
			continue
		}
		// Ambiguous: widen every member by one parent segment at a time until
		// all of them differ, or until there is nothing left to add.
		sort.Strings(group)
		for depth := 2; ; depth++ {
			seen := map[string]int{}
			cand := make(map[string]string, len(group))
			for _, root := range group {
				c := lastSegments(root, depth)
				cand[root] = c
				seen[c]++
			}
			done := true
			for _, n := range seen {
				if n > 1 {
					done = false
					break
				}
			}
			if done || depth > 6 {
				for _, root := range group {
					c := cand[root]
					if !done {
						// Genuinely indistinguishable within the depth we are
						// willing to show: fall back to the full path, which is
						// unique by construction, rather than merging rows.
						c = shortPathLabel(strings.TrimPrefix(root, "cwd:"))
					}
					out[root] = c
				}
				break
			}
		}
	}
	return out
}

// lastSegments returns the final n path segments of a normalized path.
//
// The summary keys unrooted directories as "cwd:<path>" so they cannot collide
// with a repository root; the prefix is a grouping artefact and never belongs
// in a label.
func lastSegments(p string, n int) string {
	p = strings.TrimPrefix(p, "cwd:")
	segs := strings.Split(strings.TrimPrefix(p, "/"), "/")
	if len(segs) <= n {
		return strings.Join(segs, "/")
	}
	return strings.Join(segs[len(segs)-n:], "/")
}

// unrootedInfo labels a directory with no repository above it — /tmp, a
// scratchpad, or a historical cwd that has since been deleted.
//
// It never invents a repository: Root stays empty, so nothing downstream can
// mistake this for a checkout. The LABEL is still the basename, because that is
// what the directory is called and a full path is unreadable in a narrow panel;
// uniqueness is not the label's job. The identity is the full path (carried
// separately by the caller), and DisambiguateLabels widens the label only for
// the directories that actually collide in a given view.
func unrootedInfo(cwd string) RepoInfo {
	label := lastSegment(cwd)
	if label == "" {
		label = shortPathLabel(cwd)
	}
	return RepoInfo{Root: "", Repo: label, Path: ""}
}

// shortPathLabel renders a non-repository directory compactly while keeping it
// unique: `~/…` under the home directory, and a long path elided in the MIDDLE
// rather than truncated at the end.
//
// Middle elision is the point. The distinguishing part of a scratchpad path is
// usually its tail (`…/demo2/testrepo` vs `…/demo/testrepo`), and the two
// therefore differ only in a segment a tail-truncating label would throw away —
// which is the original bug in a new costume. Keeping head and tail keeps the
// two rows two rows.
func shortPathLabel(cwd string) string {
	cwd = normalizeCwd(cwd)
	if cwd == "" {
		return ""
	}
	if home := normalizeCwd(userHome()); home != "" && hasPathPrefix(cwd, home) {
		rest := strings.TrimLeft(cwd[len(home):], "/")
		if rest == "" {
			return "~"
		}
		cwd = "~/" + rest
	}
	return elideMiddle(cwd)
}

// maxLabelSegments is how many path segments a non-repository label keeps
// before eliding: the first and the last few, which is what a human reads.
const maxLabelSegments = 4

// elideMiddle shortens a long path by dropping middle segments, keeping the
// first and the last three so both ends — the ones that identify it — survive.
func elideMiddle(p string) string {
	segs := strings.Split(p, "/")
	if len(segs) <= maxLabelSegments+1 {
		return p
	}
	head := segs[0]
	if head == "" {
		// Absolute path: keep the leading "/" plus the first real segment.
		if len(segs) > 1 {
			head = "/" + segs[1]
		} else {
			head = "/"
		}
	}
	tail := strings.Join(segs[len(segs)-3:], "/")
	return head + "/…/" + tail
}

// userHome is overridable in tests.
var userHome = func() string {
	h, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return h
}

// normalizeCwd puts a working directory into the one shape the rest of this
// file assumes: forward slashes, no trailing separator, no `.` noise. Windows
// paths arrive with backslashes and Caprock's database mixes both (a session
// captured on Windows is read on the dashboard the same way), so separator
// handling is not a formatting nicety — it decides whether a Windows session
// groups at all.
func normalizeCwd(cwd string) string {
	cwd = strings.TrimSpace(cwd)
	if cwd == "" {
		return ""
	}
	cwd = strings.ReplaceAll(cwd, `\`, "/")
	// Collapse duplicate separators (UNC prefixes keep their leading pair).
	var b strings.Builder
	b.Grow(len(cwd))
	for i := 0; i < len(cwd); i++ {
		if cwd[i] == '/' && i > 0 && cwd[i-1] == '/' {
			continue
		}
		b.WriteByte(cwd[i])
	}
	cwd = b.String()
	// Trim trailing separators, but never erase a root ("/" or "C:/").
	for len(cwd) > 1 && strings.HasSuffix(cwd, "/") && !isRootPath(cwd) {
		cwd = cwd[:len(cwd)-1]
	}
	return cwd
}

// isRootPath reports whether p is a filesystem or drive root ("/", "C:/").
func isRootPath(p string) bool {
	if p == "/" {
		return true
	}
	return len(p) == 3 && p[1] == ':' && p[2] == '/'
}

// lastSegment is the final path segment of an already-normalized path, "" for a
// root.
func lastSegment(p string) string {
	if p == "" || isRootPath(p) {
		return ""
	}
	if i := strings.LastIndexByte(p, '/'); i >= 0 {
		return p[i+1:]
	}
	return p
}

// pathEqual compares two normalized paths. Case is significant: Caprock stores
// whatever the session reported, and folding case would merge genuinely
// distinct directories on case-sensitive filesystems.
func pathEqual(a, b string) bool { return normalizeCwd(a) == normalizeCwd(b) }

// hasPathPrefix reports whether p is prefix itself or lies beneath it — on
// segment boundaries, so `/a/bc` is not under `/a/b`.
func hasPathPrefix(p, prefix string) bool {
	if prefix == "" {
		return false
	}
	if p == prefix {
		return true
	}
	if isRootPath(prefix) {
		return strings.HasPrefix(p, prefix)
	}
	return strings.HasPrefix(p, prefix) && len(p) > len(prefix) && p[len(prefix)] == '/'
}

// ProjectFromCwd derives the project label for a working directory: the
// repository it belongs to, not the basename of the directory.
//
// This is the ingest-time label written to sessions.project, so a session in
// caprock/ui is `caprock`. Kept as the same name and signature the callers
// already use.
func ProjectFromCwd(cwd string) string {
	return RepoFromCwd(cwd).Repo
}

// RepoPathFromCwd returns the path within the repository for a cwd — the second
// level of the grouping, stored so the breakdown needs no filesystem access on
// read.
func RepoPathFromCwd(cwd string) string {
	return RepoFromCwd(cwd).Path
}
