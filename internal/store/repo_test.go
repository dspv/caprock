package store

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
)

// newAssistantEvent is one priced assistant turn, the only kind the projects
// roll-up counts.
func newAssistantEvent(sessionID string, seq int64, cost float64) *event.Event {
	c := cost
	return &event.Event{
		SessionID: sessionID,
		Source:    event.SourceTranscript,
		Kind:      event.KindTurnAssistant,
		Model:     "claude-opus-5",
		Ts:        time.UnixMilli(1_000 + seq),
		Tokens:    &event.TokenDelta{In: 10, Out: 5},
		CostUSD:   &c,
		Key:       fmt.Sprintf("%s-%d", sessionID, seq),
	}
}

// newRepo makes a real git-shaped repository: a directory with a `.git`
// DIRECTORY. The resolver only ever stats `.git` and reads it when it is a
// file, so this is indistinguishable from a real clone and needs no git binary
// — which also keeps the test identical on the Windows runner.
func newRepo(t *testing.T, root string) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(root, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	return root
}

// newWorktree makes a linked worktree the way git does: a directory whose
// `.git` is a FILE holding `gitdir: <repo>/.git/worktrees/<name>`.
func newWorktree(t *testing.T, repo, dir, name string) string {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	gitdir := filepath.Join(repo, ".git", "worktrees", name)
	if err := os.MkdirAll(gitdir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".git"), []byte("gitdir: "+gitdir+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

// clearRepoCache drops memoised resolutions so a test that builds a fresh tree
// on disk is not answered from another test's cache.
func clearRepoCache() {
	repoCache.Range(func(k, _ any) bool {
		repoCache.Delete(k)
		return true
	})
}

// TestRepoFromCwdRepoRoot: a session AT the repository root is the repository,
// with no subdirectory.
func TestRepoFromCwdRepoRoot(t *testing.T) {
	clearRepoCache()
	root := newRepo(t, filepath.Join(t.TempDir(), "caprock"))
	got := RepoFromCwd(root)
	if got.Repo != "caprock" {
		t.Errorf("Repo = %q, want %q", got.Repo, "caprock")
	}
	if got.Path != "" {
		t.Errorf("Path = %q, want %q (the root itself)", got.Path, "")
	}
	if !pathEqual(got.Root, root) {
		t.Errorf("Root = %q, want %q", got.Root, root)
	}
	if got.Segment() != "/" {
		t.Errorf("Segment() = %q, want %q", got.Segment(), ".")
	}
}

// TestRepoFromCwdDeepSubdirectory: the bug this change exists to fix. A session
// in caprock/ui/src/components is caprock, not "components", and its breakdown
// segment is the FIRST directory under the root.
func TestRepoFromCwdDeepSubdirectory(t *testing.T) {
	clearRepoCache()
	root := newRepo(t, filepath.Join(t.TempDir(), "caprock"))
	deep := filepath.Join(root, "ui", "src", "components")
	if err := os.MkdirAll(deep, 0o755); err != nil {
		t.Fatal(err)
	}
	got := RepoFromCwd(deep)
	if got.Repo != "caprock" {
		t.Errorf("Repo = %q, want %q — a subdirectory is not a project", got.Repo, "caprock")
	}
	if got.Path != "ui/src/components" {
		t.Errorf("Path = %q, want %q", got.Path, "ui/src/components")
	}
	if got.Segment() != "/ui/src/components" {
		t.Errorf("Segment() = %q, want %q — the breakdown shows the directory path, not just its first segment", got.Segment(), "/ui/src/components")
	}
}

// TestRepoFromCwdWorktree: a Caprock agent's worktree belongs to the repository
// it is working on, and does NOT invent a `.caprock-worktrees` subdirectory.
func TestRepoFromCwdWorktree(t *testing.T) {
	clearRepoCache()
	root := newRepo(t, filepath.Join(t.TempDir(), "testrepo"))
	wt := newWorktree(t, root, filepath.Join(root, WorktreeDir, "worker-1"), "worker-1")
	got := RepoFromCwd(wt)
	if got.Repo != "testrepo" {
		t.Errorf("Repo = %q, want %q — a worker works on the parent repository", got.Repo, "testrepo")
	}
	if !pathEqual(got.Root, root) {
		t.Errorf("Root = %q, want the parent repo %q", got.Root, root)
	}
	if got.Path != "" {
		t.Errorf("Path = %q, want %q — a worktree is a branch, not a directory of the repo", got.Path, "")
	}
}

// TestRepoFromCwdWorktreeOutsideRepo covers the other worktree shape: a linked
// worktree checked out somewhere else entirely still resolves to its parent.
func TestRepoFromCwdWorktreeOutsideRepo(t *testing.T) {
	clearRepoCache()
	base := t.TempDir()
	root := newRepo(t, filepath.Join(base, "myrepo"))
	wt := newWorktree(t, root, filepath.Join(base, "elsewhere", "wt-2"), "wt-2")
	got := RepoFromCwd(wt)
	if got.Repo != "myrepo" {
		t.Errorf("Repo = %q, want %q", got.Repo, "myrepo")
	}
	if got.Path != "" {
		t.Errorf("Path = %q, want %q — the worktree is not under the root", got.Path, "")
	}
}

// TestRepoFromCwdNoRepository: /tmp and scratchpad paths get an honest
// path-shaped label and NO repository root — never a fabricated repo name.
func TestRepoFromCwdNoRepository(t *testing.T) {
	clearRepoCache()
	dir := filepath.Join(t.TempDir(), "scratch", "notarepo")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	got := RepoFromCwd(dir)
	if got.Root != "" {
		t.Errorf("Root = %q, want empty — there is no repository here", got.Root)
	}
	// The label is still the directory's name — that is what a person calls it,
	// and a full path is unreadable in the panel. What must NOT happen is a
	// claimed repository root, which is what would let unrelated directories be
	// treated as one checkout.
	if got.Repo != "notarepo" {
		t.Errorf("Repo = %q, want %q — the directory still needs a readable label", got.Repo, "notarepo")
	}
	if got.Path != "" {
		t.Errorf("Path = %q, want empty — there is no repository to be inside of", got.Path)
	}
}

// TestRepoFromCwdSameBasenameDifferentPaths is the silent-summing bug: two
// unrelated repositories that share a basename must stay two identities.
func TestRepoFromCwdSameBasenameDifferentPaths(t *testing.T) {
	clearRepoCache()
	base := t.TempDir()
	a := newRepo(t, filepath.Join(base, "demo", "testrepo"))
	b := newRepo(t, filepath.Join(base, "demo2", "testrepo"))
	ia, ib := RepoFromCwd(a), RepoFromCwd(b)
	if ia.Root == ib.Root {
		t.Fatalf("both roots resolved to %q — unrelated repositories collapsed into one", ia.Root)
	}
	// The label alone is allowed to repeat; the identity must not, and the
	// display layer separates them.
	labels := DisambiguateLabels(map[string]string{ia.Root: ia.Repo, ib.Root: ib.Repo})
	if labels[ia.Root] == labels[ib.Root] {
		t.Fatalf("both display labels are %q — the panel would sum unrelated work into one row", labels[ia.Root])
	}
	for root, want := range map[string]string{ia.Root: "demo/testrepo", ib.Root: "demo2/testrepo"} {
		if got := labels[root]; got != want {
			t.Errorf("label for %q = %q, want %q", root, got, want)
		}
	}
}

// TestDisambiguateLabelsLeavesUniqueLabelsAlone: the common case must read the
// way a person says it, so widening only happens on an actual collision.
func TestDisambiguateLabelsLeavesUniqueLabelsAlone(t *testing.T) {
	in := map[string]string{
		"/Users/x/dev/caprock":   "caprock",
		"/Users/x/dev/amarketer": "amarketer",
	}
	got := DisambiguateLabels(in)
	for root, want := range in {
		if got[root] != want {
			t.Errorf("label for %q = %q, want the plain %q", root, got[root], want)
		}
	}
}

// TestRepoFromCwdWindowsSeparators is rule 2 in test form. A cwd captured on
// Windows arrives with backslashes; if the derivation only understands "/",
// every Windows session lands in one nameless bucket. The assertions here are
// on STRING handling, so they run — and must pass — on every OS.
func TestRepoFromCwdWindowsSeparators(t *testing.T) {
	clearRepoCache()
	// Path handling, independent of the filesystem: a Windows path with no repo
	// on this machine still has to split into the right segments.
	for _, tc := range []struct {
		in       string
		wantLast string
	}{
		{`C:\Users\x\dev\caprock`, "caprock"},
		{`C:\Users\x\dev\caprock\`, "caprock"},
		{`C:\Users\x\dev\caprock\\ui`, "ui"},
	} {
		if got := lastSegment(normalizeCwd(tc.in)); got != tc.wantLast {
			t.Errorf("lastSegment(normalizeCwd(%q)) = %q, want %q", tc.in, got, tc.wantLast)
		}
	}
	if got := normalizeCwd(`C:\`); got != "C:/" {
		t.Errorf("normalizeCwd(%q) = %q, want %q — a drive root must survive trimming", `C:\`, got, "C:/")
	}
	if !hasPathPrefix(`C:/Users/x/dev/caprock/ui`, `C:/Users/x/dev/caprock`) {
		t.Error("a Windows subdirectory was not recognised as being under its repository")
	}
	if hasPathPrefix(`C:/Users/x/dev/caprock-ui`, `C:/Users/x/dev/caprock`) {
		t.Error("caprock-ui must not count as being under caprock (segment boundaries)")
	}
	// And the real thing on a real tree, using the host's own separator, so the
	// Windows runner exercises backslashes end to end.
	root := newRepo(t, filepath.Join(t.TempDir(), "winrepo"))
	deep := filepath.Join(root, "internal", "store")
	if err := os.MkdirAll(deep, 0o755); err != nil {
		t.Fatal(err)
	}
	got := RepoFromCwd(deep)
	if got.Repo != "winrepo" || got.Path != "internal/store" {
		t.Errorf("RepoFromCwd(%q) = {Repo:%q Path:%q}, want {winrepo internal/store}", deep, got.Repo, got.Path)
	}
	if strings.Contains(got.Path, `\`) {
		t.Errorf("Path = %q still holds a backslash; repo_path must be slash-separated so the SQL segment cut is platform-independent", got.Path)
	}
	if runtime.GOOS == "windows" && !strings.Contains(deep, `\`) {
		t.Skip("expected a backslash path on Windows")
	}
}

// TestRepoFromCwdSubmoduleStaysItsOwnRepo: a submodule's `.git` file points at
// `.git/modules/...`, not `.git/worktrees/...`, and it is a repository in its
// own right — it must not be folded into the superproject.
func TestRepoFromCwdSubmoduleStaysItsOwnRepo(t *testing.T) {
	clearRepoCache()
	super := newRepo(t, filepath.Join(t.TempDir(), "super"))
	sub := filepath.Join(super, "vendor", "lib")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	modules := filepath.Join(super, ".git", "modules", "lib")
	if err := os.MkdirAll(modules, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sub, ".git"), []byte("gitdir: "+modules+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := RepoFromCwd(sub); got.Repo != "lib" {
		t.Errorf("Repo = %q, want %q — a submodule is its own repository", got.Repo, "lib")
	}
}

// TestSummarizeGroupsByRepository is the end-to-end shape the Projects panel
// renders: one row per repository, with the per-directory breakdown inside it.
//
// The breakdown is charged by what the turns TOUCHED, so this drives it the way
// the real thing works — one session at the repository root whose turns edit
// files in different directories — rather than by launching a session per
// directory, which is exactly the signal per-directory attribution replaced.
func TestSummarizeGroupsByRepository(t *testing.T) {
	clearRepoCache()
	ctx := context.Background()
	s := openTest(t)
	root := newRepo(t, filepath.Join(t.TempDir(), "caprock"))
	ui := filepath.Join(root, "ui")
	internal := filepath.Join(root, "internal", "store")
	if err := UpsertSession(ctx, s.db, "s1", SessionPatch{Cwd: root}); err != nil {
		t.Fatal(err)
	}
	// One session, three turns, each placed by a touch in exactly one
	// directory. The touch precedes the turn it places: attribution carries
	// forward, and the tool calls Claude makes while working on a file come
	// before the turn they produce.
	for i, spec := range []struct {
		msg  string
		dir  string
		cost float64
	}{
		{"m-root", root, 1},
		{"m-ui", ui, 4},
		{"m-internal", internal, 2},
	} {
		addTouch(t, s, "s1", spec.msg, int64(2*i+1), filepath.Join(spec.dir, "f.go"))
		addTurn(t, s, "s1", spec.msg, int64(2*i+2), spec.cost)
	}
	sum, err := Summarize(ctx, s.db, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(sum.Projects) != 1 {
		t.Fatalf("got %d project rows, want 1 repository row: %+v", len(sum.Projects), sum.Projects)
	}
	p := sum.Projects[0]
	if p.Project != "caprock" {
		t.Errorf("Project = %q, want %q", p.Project, "caprock")
	}
	if p.CostUSD != 7 {
		t.Errorf("CostUSD = %v, want 7 (the repository total)", p.CostUSD)
	}
	got := map[string]float64{}
	for _, ps := range p.Paths {
		got[ps.Path] = ps.CostUSD
	}
	for path, want := range map[string]float64{"/": 1, "/ui": 4, "/internal/store": 2} {
		if got[path] != want {
			t.Errorf("breakdown[%q] = %v, want %v (%+v)", path, got[path], want, p.Paths)
		}
	}
	// The breakdown must be ordered by spend, so the expensive directory is the
	// first thing read.
	if p.Paths[0].Path != "/ui" {
		t.Errorf("breakdown starts with %q, want the most expensive directory %q", p.Paths[0].Path, "/ui")
	}
	// And the parts must add up to the whole, or the panel states two different
	// totals for the same repository (rule 6).
	var sumPaths float64
	var sumTurns int64
	for _, ps := range p.Paths {
		sumPaths += ps.CostUSD
		sumTurns += ps.Turns
	}
	if sumPaths != p.CostUSD || sumTurns != 3 {
		t.Errorf("breakdown sums to $%v/%d turns, but the row says $%v and 3 turns", sumPaths, sumTurns, p.CostUSD)
	}
}

// TestSummarizeKeepsSameBasenameRepositoriesApart is the collision bug at the
// level the user actually sees: the summary, not the helper.
func TestSummarizeKeepsSameBasenameRepositoriesApart(t *testing.T) {
	clearRepoCache()
	ctx := context.Background()
	s := openTest(t)
	base := t.TempDir()
	a := newRepo(t, filepath.Join(base, "demo", "testrepo"))
	b := newRepo(t, filepath.Join(base, "demo2", "testrepo"))
	for i, spec := range []struct {
		id   string
		cwd  string
		cost float64
	}{{"a1", a, 3}, {"b1", b, 5}} {
		if err := UpsertSession(ctx, s.db, spec.id, SessionPatch{Cwd: spec.cwd}); err != nil {
			t.Fatal(err)
		}
		if _, err := InsertEvent(ctx, s.db, newAssistantEvent(spec.id, int64(i+1), spec.cost)); err != nil {
			t.Fatal(err)
		}
	}
	sum, err := Summarize(ctx, s.db, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(sum.Projects) != 2 {
		t.Fatalf("got %d rows, want 2 — two unrelated repositories summed into one: %+v", len(sum.Projects), sum.Projects)
	}
	seen := map[string]float64{}
	for _, p := range sum.Projects {
		if _, dup := seen[p.Project]; dup {
			t.Fatalf("two rows share the label %q; the panel cannot tell them apart", p.Project)
		}
		seen[p.Project] = p.CostUSD
	}
	if seen["demo/testrepo"] != 3 || seen["demo2/testrepo"] != 5 {
		t.Errorf("labels/costs = %+v, want demo/testrepo=$3 and demo2/testrepo=$5", seen)
	}
}

// TestSummarizeKeepsSameBasenameNonRepositoriesApart: the collision bug for
// directories that are NOT repositories — the scratchpad paths that dominate a
// real database. They share a basename and have no root to tell them apart, so
// the summary has to key them on their own cwd.
func TestSummarizeKeepsSameBasenameNonRepositoriesApart(t *testing.T) {
	clearRepoCache()
	ctx := context.Background()
	s := openTest(t)
	base := t.TempDir()
	// Deliberately NOT repositories: no .git anywhere above them.
	a := filepath.Join(base, "livegraph", "scratch")
	b := filepath.Join(base, "orch-live", "scratch")
	for i, spec := range []struct {
		id   string
		cwd  string
		cost float64
	}{{"na", a, 3}, {"nb", b, 7}} {
		if err := os.MkdirAll(spec.cwd, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := UpsertSession(ctx, s.db, spec.id, SessionPatch{Cwd: spec.cwd}); err != nil {
			t.Fatal(err)
		}
		if _, err := InsertEvent(ctx, s.db, newAssistantEvent(spec.id, int64(i+1), spec.cost)); err != nil {
			t.Fatal(err)
		}
	}
	sum, err := Summarize(ctx, s.db, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(sum.Projects) != 2 {
		t.Fatalf("got %d rows, want 2 — two unrelated directories summed into one: %+v", len(sum.Projects), sum.Projects)
	}
	if sum.Projects[0].Project == sum.Projects[1].Project {
		t.Fatalf("both rows are labelled %q; the panel cannot tell them apart", sum.Projects[0].Project)
	}
	byLabel := map[string]float64{}
	for _, p := range sum.Projects {
		byLabel[p.Project] = p.CostUSD
	}
	// Assert the property, not the exact label: how much elision a path needs
	// differs between a short /tmp on POSIX and a long
	// C:\\Users\\RUNNER~1\\AppData\\Local\\Temp on Windows, so pinning the string
	// pins the runner rather than the behaviour. What must hold everywhere is
	// that each label carries the segment that tells the two apart — a label
	// reduced to the shared basename "scratch" is the original bug, and
	// disambiguation papering over it afterwards is not the same thing.
	for _, want := range []struct {
		seg  string
		cost float64
	}{{"livegraph", 3}, {"orch-live", 7}} {
		found := ""
		for label := range byLabel {
			if strings.Contains(label, want.seg) {
				found = label
			}
		}
		if found == "" {
			t.Errorf("no label contains %q, so the two rows are told apart by something other than their own paths: %+v", want.seg, byLabel)
			continue
		}
		if byLabel[found] != want.cost {
			t.Errorf("label %q has cost %v, want %v", found, byLabel[found], want.cost)
		}
	}
}

// TestSummarizeSingleDirectoryRepoHasNoBreakdown: one directory is not a
// breakdown; repeating the row's own total under itself is noise.
func TestSummarizeSingleDirectoryRepoHasNoBreakdown(t *testing.T) {
	clearRepoCache()
	ctx := context.Background()
	s := openTest(t)
	root := newRepo(t, filepath.Join(t.TempDir(), "solo"))
	if err := UpsertSession(ctx, s.db, "only", SessionPatch{Cwd: root}); err != nil {
		t.Fatal(err)
	}
	if _, err := InsertEvent(ctx, s.db, newAssistantEvent("only", 1, 2)); err != nil {
		t.Fatal(err)
	}
	sum, err := Summarize(ctx, s.db, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(sum.Projects) != 1 {
		t.Fatalf("want 1 row, got %+v", sum.Projects)
	}
	if sum.Projects[0].Paths != nil {
		t.Errorf("Paths = %+v, want none for a single-directory repository", sum.Projects[0].Paths)
	}
}

// TestBackfillRepoLabelsHistoricalSessions: rows written before this change
// carry basename labels, and opening the database must re-derive them —
// including for a directory that no longer exists, which is the case a
// read-time walk can never answer.
func TestBackfillRepoLabelsHistoricalSessions(t *testing.T) {
	clearRepoCache()
	ctx := context.Background()
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "caprock.db")
	repo := newRepo(t, filepath.Join(dir, "amarketer"))
	app := filepath.Join(repo, "app")
	if err := os.MkdirAll(app, 0o755); err != nil {
		t.Fatal(err)
	}
	gone := filepath.Join(dir, "vanished", "testrepo")

	s, err := Open(ctx, dbPath, nil)
	if err != nil {
		t.Fatal(err)
	}
	// Write the OLD shape directly: the basename label, and no resolution — the
	// state migration 0011 finds on a real database.
	for _, spec := range []struct{ id, cwd, project string }{
		{"old-app", app, "app"},
		{"old-gone", gone, "testrepo"},
	} {
		if _, err := s.db.ExecContext(ctx,
			`INSERT INTO sessions(session_id, cwd, project, status, repo_root, repo_path) VALUES(?, ?, ?, 'ended', NULL, NULL)`,
			spec.id, spec.cwd, spec.project); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	clearRepoCache()
	s2, err := Open(ctx, dbPath, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer s2.Close()

	got, err := GetSession(ctx, s2.db, "old-app")
	if err != nil {
		t.Fatal(err)
	}
	if got.Project != "amarketer" {
		t.Errorf("backfilled project = %q, want %q — a subdirectory is not a project", got.Project, "amarketer")
	}
	if got.RepoPath != "app" {
		t.Errorf("backfilled repo_path = %q, want %q", got.RepoPath, "app")
	}

	// The directory is gone, so there is no repository to find. The label must
	// still be stable and must not claim a repository.
	goneSession, err := GetSession(ctx, s2.db, "old-gone")
	if err != nil {
		t.Fatal(err)
	}
	if goneSession.RepoRoot != "" {
		t.Errorf("repo_root = %q for a directory that does not exist, want empty", goneSession.RepoRoot)
	}
	if goneSession.Project != "testrepo" {
		t.Errorf("project = %q, want %q — a vanished directory still gets its own name as a label", goneSession.Project, "testrepo")
	}
}
