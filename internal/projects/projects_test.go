package projects

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/store"
)

func needGit(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
}

// git runs git in dir as a person at a terminal would.
func git(t *testing.T, dir string, args ...string) string {
	t.Helper()
	c := exec.Command("git", append([]string{"-C", dir}, args...)...)
	c.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t", "GIT_CONFIG_NOSYSTEM=1")
	out, err := c.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

// newRepo is a repository with one commit on main.
func newRepo(t *testing.T, dir string) string {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	git(t, dir, "init", "-q", "-b", "main")
	if err := os.WriteFile(filepath.Join(dir, "f"), []byte("x\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	git(t, dir, "add", "f")
	git(t, dir, "commit", "-q", "-m", "init")
	return dir
}

func hasGitDir(root string) bool {
	st, err := os.Stat(filepath.Join(filepath.FromSlash(root), ".git"))
	return err == nil && st.IsDir()
}

// newService is a service on an in-memory store. Test folders live in the
// temp directory, which the real Eligible rules out, so it is replaced by
// the part of the rule a test can exercise.
func newService(t *testing.T) (*Service, *store.Store, *bus.Bus) {
	t.Helper()
	st, err := store.Open(context.Background(), ":memory:", slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	b := bus.New()
	s := New(st, b, slog.New(slog.NewTextHandler(io.Discard, nil)))
	s.Eligible = hasGitDir
	return s, st, b
}

func start(t *testing.T, s *Service) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	if err := s.Start(ctx); err != nil {
		t.Fatal(err)
	}
	// Before the folders made earlier are removed: Windows will not delete a
	// folder a watcher or a git still holds. A folder made after start would
	// be removed first, so tests make theirs before.
	t.Cleanup(s.Close)
}

func session(t *testing.T, st *store.Store, id, cwd string) {
	t.Helper()
	if err := store.UpsertSession(context.Background(), st.DB(), id, store.SessionPatch{Cwd: cwd}); err != nil {
		t.Fatal(err)
	}
}

// waitFrame waits for a project frame for id that satisfies ok.
func waitFrame(t *testing.T, sub *bus.Subscriber, id int64, within time.Duration, ok func(View) bool) {
	t.Helper()
	deadline := time.After(within)
	for {
		select {
		case f := <-sub.C:
			if v, isView := f.Data.(View); f.Type == FrameProject && isView && v.ID == id && ok(v) {
				return
			}
		case <-deadline:
			t.Fatalf("no matching project frame for %d within %s", id, within)
		}
	}
}

// The list starts as the repositories sessions ran in: once, at first start,
// never a subdirectory or a worktree as its own project, never a folder that
// is not a repository, and never again a project the owner unlisted.
func TestSeedingListsTheRepositoriesSessionsRanIn(t *testing.T) {
	needGit(t)
	base := t.TempDir()
	a := newRepo(t, filepath.Join(base, "alpha"))
	b := newRepo(t, filepath.Join(base, "beta"))
	plain := filepath.Join(base, "notes")
	_ = os.MkdirAll(filepath.Join(a, "sub"), 0o755)
	_ = os.MkdirAll(plain, 0o755)
	wt, err := agents.AddWorktree(context.Background(), a, agents.WorktreeSpec{Branch: "feat/x", Create: true})
	if err != nil {
		t.Fatal(err)
	}
	s, st, _ := newService(t)
	session(t, st, "s1", a)
	session(t, st, "s2", filepath.Join(a, "sub"))
	session(t, st, "s3", b)
	session(t, st, "s4", plain)
	session(t, st, "s5", wt.Path)
	start(t, s)
	list, err := s.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var roots []string
	for _, v := range list {
		roots = append(roots, v.Root)
		if v.Source != store.ProjectSourceSeed || v.Kind != store.ProjectKindRepo {
			t.Errorf("%s: source %s kind %s", v.Root, v.Source, v.Kind)
		}
	}
	// Listed by name, so alpha comes first whichever spelling won.
	if len(list) != 2 || !sameDir(list[0].Root, a) || !sameDir(list[1].Root, b) {
		t.Fatalf("seeded %v; want alpha and beta only", roots)
	}
	if err := s.Unlist(context.Background(), list[0].ID); err != nil {
		t.Fatal(err)
	}
	// A new run of the daemon does not seed again, and a session in the
	// unlisted repository does not bring it back.
	s2 := New(st, bus.New(), s.Log)
	s2.Eligible = hasGitDir
	start(t, s2)
	s2.noteSession(context.Background(), mustSession(t, st, "s1"))
	list, _ = s2.List(context.Background())
	if len(list) != 1 || !sameDir(list[0].Root, b) {
		t.Fatalf("after unlisting alpha: %d projects", len(list))
	}
	if _, err := os.Stat(a); err != nil {
		t.Fatal("unlisting touched the folder")
	}
}

// A session in a repository not yet listed lists it, as the session runs.
func TestASessionInANewRepositoryListsIt(t *testing.T) {
	needGit(t)
	repo := newRepo(t, filepath.Join(t.TempDir(), "gamma"))
	s, st, b := newService(t)
	start(t, s)
	sub := b.Subscribe(256)
	session(t, st, "s1", repo)
	s.noteSession(context.Background(), mustSession(t, st, "s1"))
	list, _ := s.List(context.Background())
	if len(list) != 1 || list[0].Source != store.ProjectSourceSession {
		t.Fatalf("list = %+v", list)
	}
	waitFrame(t, sub, list[0].ID, 3*time.Second, func(v View) bool { return v.Git != nil && v.Git.At > 0 })
}

func mustSession(t *testing.T, st *store.Store, id string) store.Session {
	t.Helper()
	s, err := store.GetSession(context.Background(), st.DB(), id)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// sameDir compares folders the way the service does: one folder under two
// spellings (/var and /private/var) is one.
func sameDir(a, b string) bool {
	return sameFolder(filepath.FromSlash(a), filepath.FromSlash(b))
}

// WP-05: a commit or a checkout made in a terminal outside Caprock reaches a
// project frame within a second, without polling.
func TestACommitOutsideCaprockReachesAFrameWithinASecond(t *testing.T) {
	needGit(t)
	repo := newRepo(t, filepath.Join(t.TempDir(), "delta"))
	s, _, b := newService(t)
	start(t, s)
	sub := b.Subscribe(1024)
	v, _, err := s.Add(context.Background(), repo)
	if err != nil {
		t.Fatal(err)
	}
	waitFrame(t, sub, v.ID, 5*time.Second, func(v View) bool { return v.Git != nil && v.Git.Branch == "main" && v.Git.At > 0 })

	// The budget is a second after the debounce; Windows CI runners start a
	// git in a few hundred milliseconds on their own, so they get three.
	budget := time.Second + DefaultDebounce
	if runtime.GOOS == "windows" {
		budget = 3 * time.Second
	}
	git(t, repo, "checkout", "-q", "-b", "topic")
	done := time.Now()
	waitFrame(t, sub, v.ID, budget, func(v View) bool { return v.Git.Branch == "topic" })
	t.Logf("checkout to frame: %s", time.Since(done))

	if err := os.WriteFile(filepath.Join(repo, "g"), []byte("y\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	git(t, repo, "add", "g")
	done = time.Now()
	waitFrame(t, sub, v.ID, budget, func(v View) bool { return v.Git.Dirty && v.Git.Changed == 1 })
	t.Logf("stage to frame: %s", time.Since(done))

	git(t, repo, "commit", "-q", "-m", "g")
	done = time.Now()
	waitFrame(t, sub, v.ID, budget, func(v View) bool { return !v.Git.Dirty })
	t.Logf("commit to frame: %s", time.Since(done))
}

// WP-05: idle projects cost no git at all.
func TestIdleProjectsRunNoGit(t *testing.T) {
	needGit(t)
	s, st, _ := newService(t)
	base := t.TempDir()
	const n = 6
	for i := 0; i < n; i++ {
		repo := newRepo(t, filepath.Join(base, "r"+string(rune('a'+i))))
		session(t, st, "s"+string(rune('a'+i)), repo)
	}
	start(t, s)
	deadline := time.Now().Add(15 * time.Second)
	for s.GitRuns() < n && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if s.GitRuns() < n {
		t.Fatalf("priming ran git %d times; want once per project (%d)", s.GitRuns(), n)
	}
	// Settle first. Windows reports the last-write times of the files the
	// test's own commits wrote some time after the commits, through the
	// watcher, which costs one more status per project once. A refresh that
	// woke its own watcher would never settle: it would ask again every
	// debounce, forever.
	settled := s.GitRuns()
	quietSince := time.Now()
	for time.Since(quietSince) < 1500*time.Millisecond {
		if time.Now().After(deadline) {
			t.Fatalf("git never went quiet: %d runs for %d idle projects", s.GitRuns(), n)
		}
		time.Sleep(50 * time.Millisecond)
		if got := s.GitRuns(); got != settled {
			settled, quietSince = got, time.Now()
		}
	}
	if settled > 2*n {
		t.Fatalf("settling ran git %d times for %d projects", settled, n)
	}
	time.Sleep(3 * time.Second)
	if got := s.GitRuns(); got != settled {
		t.Fatalf("idle projects ran git %d more times; nothing changed", got-settled)
	}
}

// WP-05: a git that hangs is stopped at the timeout and the reason shown.
func TestAGitThatHangsIsStoppedAndReported(t *testing.T) {
	needGit(t)
	if runtime.GOOS == "windows" {
		t.Skip("the hanging git is a shell script")
	}
	hang := filepath.Join(t.TempDir(), "git")
	if err := os.WriteFile(hang, []byte("#!/bin/sh\nexec sleep 30\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	old := gitBin
	gitBin = hang
	t.Cleanup(func() { gitBin = old })
	repo := newRepo(t, filepath.Join(t.TempDir(), "eps"))
	s, _, _ := newService(t)
	s.GitTimeout = 300 * time.Millisecond
	start(t, s)
	began := time.Now()
	v, _, err := s.Add(context.Background(), repo)
	if err != nil {
		t.Fatal(err)
	}
	s.refreshNow(v.ID)
	if took := time.Since(began); took > 3*time.Second {
		t.Fatalf("a hanging git held the refresh for %s", took)
	}
	got, _ := s.Get(context.Background(), v.ID)
	if got.Git == nil || !strings.Contains(got.Git.Error, "did not answer in time") {
		t.Fatalf("git = %+v; the timeout is not reported", got.Git)
	}
}

// A clone runs in the background, reports progress, lists the project when
// done, and a second request with the same op_id returns the first
// operation instead of starting another clone.
func TestCloneIsOneOperationPerOpID(t *testing.T) {
	needGit(t)
	srcParent := t.TempDir()
	newRepo(t, filepath.Join(srcParent, "src"))
	s, _, b := newService(t)
	// The https address is rewritten to the local folder, so the test needs
	// no network and the address still passes CheckCloneURL.
	s.Env = func() []string {
		return append(os.Environ(), "GIT_CONFIG_COUNT=1",
			"GIT_CONFIG_KEY_0=url."+filepath.ToSlash(srcParent)+"/.insteadOf", "GIT_CONFIG_VALUE_0=https://example.invalid/")
	}
	parent := t.TempDir()
	start(t, s)
	sub := b.Subscribe(1024)
	op, existing, err := s.Clone("phone-op-1", "https://example.invalid/src", parent, "")
	if err != nil || existing {
		t.Fatalf("clone: %v existing=%v", err, existing)
	}
	again, existing, err := s.Clone("phone-op-1", "https://example.invalid/src", parent, "")
	if err != nil || !existing || again.ID != op.ID || again.StartedAt != op.StartedAt {
		t.Fatalf("second request: %+v existing=%v err=%v; a retry must return the first operation", again, existing, err)
	}
	deadline := time.After(20 * time.Second)
	var final Op
	for final.State != OpDone && final.State != OpFailed {
		select {
		case f := <-sub.C:
			if o, ok := f.Data.(Op); ok && f.Type == FrameOp && o.ID == "phone-op-1" {
				final = o
			}
		case <-deadline:
			t.Fatal("the clone never finished")
		}
	}
	if final.State != OpDone || final.ProjectID == 0 {
		t.Fatalf("clone ended %+v", final)
	}
	if got, ok := s.GetOp("phone-op-1"); !ok || got.State != OpDone {
		t.Fatalf("a client coming back finds %+v", got)
	}
	v, err := s.Get(context.Background(), final.ProjectID)
	if err != nil || v.Source != store.ProjectSourceClone || !sameDir(v.Root, filepath.Join(parent, "src")) {
		t.Fatalf("project %+v err %v", v, err)
	}
	if _, _, err := s.Clone("phone-op-2", "https://example.invalid/src", parent, ""); err == nil {
		t.Fatal("cloned over an existing folder")
	}
}

func TestCloneTakesOnlyARepositoryAddress(t *testing.T) {
	for _, ok := range []string{"https://github.com/dspv/caprock.git", "https://gitlab.com/a/b/c", "git@github.com:dspv/caprock.git"} {
		if err := CheckCloneURL(ok); err != nil {
			t.Errorf("%s refused: %v", ok, err)
		}
	}
	for _, bad := range []string{"", "/etc", "file:///etc", "ext::sh -c touch% /tmp/x", "-uhttps://x/y", "http://github.com/a/b",
		"ssh://git@github.com/a/b", "https://github.com", "git@-oProxyCommand=x:a/b", "https://github.com/a b"} {
		if err := CheckCloneURL(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
	if n := repoNameFromURL("git@github.com:dspv/caprock.git"); n != "caprock" {
		t.Errorf("name = %q", n)
	}
	if n := repoNameFromURL("https://github.com/dspv/caprock/"); n != "caprock" {
		t.Errorf("name = %q", n)
	}
}

// WP-08: a worktree on an existing branch, on a new one from a base, and on
// a branch only the remote has (created and tracking it); a branch checked
// out elsewhere is refused with git's own message.
func TestWorktreesOnAnyBranch(t *testing.T) {
	needGit(t)
	base := t.TempDir()
	origin := newRepo(t, filepath.Join(base, "origin"))
	git(t, origin, "branch", "feature/remote")
	git(t, base, "clone", "-q", origin, filepath.Join(base, "local"))
	local := filepath.Join(base, "local")
	git(t, local, "branch", "existing")
	s, _, _ := newService(t)
	start(t, s)
	v, _, err := s.Add(context.Background(), local)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	wt, err := s.AddWorktree(ctx, v.ID, agents.WorktreeSpec{Branch: "feature/remote"})
	if err != nil {
		t.Fatal(err)
	}
	if wt.Tracks != "origin/feature/remote" || git(t, local, "rev-parse", "--abbrev-ref", "feature/remote@{upstream}") != "origin/feature/remote" {
		t.Fatalf("remote-only branch: %+v; not tracking", wt)
	}
	if filepath.Base(wt.Path) != "feature-remote" || filepath.Base(filepath.Dir(wt.Path)) != agents.WorktreeDir {
		t.Fatalf("path %s", wt.Path)
	}
	if _, err := s.AddWorktree(ctx, v.ID, agents.WorktreeSpec{Branch: "existing"}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AddWorktree(ctx, v.ID, agents.WorktreeSpec{Branch: "brand-new", Create: true, Base: "main"}); err != nil {
		t.Fatal(err)
	}
	_, err = s.AddWorktree(ctx, v.ID, agents.WorktreeSpec{Branch: "main"})
	if err == nil || !strings.Contains(err.Error(), "main") || !strings.Contains(err.Error(), "already") {
		t.Fatalf("a branch checked out elsewhere: %v; want git's own refusal", err)
	}
	for _, bad := range []string{"", "-x", "a..b", "nope-not-anywhere"} {
		if _, err := s.AddWorktree(ctx, v.ID, agents.WorktreeSpec{Branch: bad}); err == nil {
			t.Errorf("branch %q accepted", bad)
		}
	}
	wts, err := s.Worktrees(ctx, v.ID)
	if err != nil || len(wts) != 3 {
		t.Fatalf("worktrees %+v err %v", wts, err)
	}
	for _, w := range wts {
		if !w.Caprock {
			t.Errorf("%s not marked as Caprock's", w.Path)
		}
	}
	// The main checkout does not read as changed because worktrees live in it.
	got, _ := s.Get(ctx, v.ID)
	if got.Git.Dirty {
		t.Fatalf("the worktrees folder makes the project dirty: %+v", got.Git)
	}
}

// WP-08: a dirty worktree is never removed; a clean one is, its branch kept;
// a worktree Caprock did not make is refused.
func TestOnlyACleanCaprockWorktreeIsRemoved(t *testing.T) {
	needGit(t)
	base := t.TempDir()
	repo := newRepo(t, filepath.Join(base, "repo"))
	git(t, repo, "worktree", "add", "-q", "-b", "mine", filepath.Join(base, "mine"))
	s, _, _ := newService(t)
	start(t, s)
	v, _, _ := s.Add(context.Background(), repo)
	ctx := context.Background()
	wt, err := s.AddWorktree(ctx, v.ID, agents.WorktreeSpec{Branch: "work", Create: true})
	if err != nil {
		t.Fatal(err)
	}
	name := filepath.Base(wt.Path)
	if err := os.WriteFile(filepath.Join(wt.Path, "untracked"), []byte("keep me"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := s.RemoveWorktree(ctx, v.ID, name); !errors.Is(err, agents.ErrWorktreeDirty) {
		t.Fatalf("dirty worktree: %v", err)
	}
	if _, err := os.Stat(filepath.Join(wt.Path, "untracked")); err != nil {
		t.Fatal("a dirty worktree lost a file")
	}
	_ = os.Remove(filepath.Join(wt.Path, "untracked"))
	if err := s.RemoveWorktree(ctx, v.ID, name); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(wt.Path); !os.IsNotExist(err) {
		t.Fatal("the clean worktree is still there")
	}
	git(t, repo, "rev-parse", "--verify", "work") // the branch is kept
	if err := s.RemoveWorktree(ctx, v.ID, "mine"); err == nil {
		t.Fatal("removed a worktree Caprock did not make")
	}
	if err := s.RemoveWorktree(ctx, v.ID, "../mine"); err == nil {
		t.Fatal("a name with a separator was accepted")
	}
}

// Adding a folder inside a repository lists the repository; adding twice
// returns the same project; creating makes one folder and can git init it.
func TestAddAndCreate(t *testing.T) {
	needGit(t)
	base := t.TempDir()
	repo := newRepo(t, filepath.Join(base, "repo"))
	_ = os.MkdirAll(filepath.Join(repo, "deep", "er"), 0o755)
	s, _, _ := newService(t)
	start(t, s)
	ctx := context.Background()
	v, created, err := s.Add(ctx, filepath.Join(repo, "deep", "er"))
	if err != nil || !created || !sameDir(v.Root, repo) || v.Kind != store.ProjectKindRepo {
		t.Fatalf("add: %+v created=%v err=%v", v, created, err)
	}
	again, created, err := s.Add(ctx, repo)
	if err != nil || created || again.ID != v.ID {
		t.Fatalf("second add: %+v created=%v", again, created)
	}
	if _, _, err := s.Add(ctx, "relative/path"); err == nil {
		t.Fatal("a relative path was accepted")
	}
	nv, err := s.Create(ctx, base, "fresh", true)
	if err != nil || nv.Kind != store.ProjectKindRepo || nv.Source != store.ProjectSourceNew || !hasGitDir(nv.Root) {
		t.Fatalf("create: %+v err=%v", nv, err)
	}
	fv, err := s.Create(ctx, base, "plain", false)
	if err != nil || fv.Kind != store.ProjectKindFolder || fv.Git != nil {
		t.Fatalf("create folder: %+v err=%v", fv, err)
	}
	for _, bad := range []string{"", "..", "a/b", `a\b`, "x\x00"} {
		if _, err := s.Create(ctx, base, bad, false); err == nil {
			t.Errorf("name %q accepted", bad)
		}
	}
	if _, err := s.Create(ctx, filepath.Join(base, "missing"), "x", false); err == nil {
		t.Fatal("created under a parent that does not exist")
	}
	if _, err := s.Create(ctx, base, "fresh", false); err == nil {
		t.Fatal("created over an existing folder")
	}
}

func TestPatch(t *testing.T) {
	needGit(t)
	repo := newRepo(t, filepath.Join(t.TempDir(), "p"))
	s, _, _ := newService(t)
	start(t, s)
	v, _, _ := s.Add(context.Background(), repo)
	name, pinned, sort := "Renamed", true, int64(3)
	defaults := jsonRaw(`{"agent":"codex","model":"gpt-5.6"}`)
	got, err := s.Update(context.Background(), v.ID, Patch{Name: &name, Pinned: &pinned, Sort: &sort, Defaults: &defaults})
	if err != nil || got.Name != "Renamed" || !got.Pinned || got.Sort != 3 || string(got.Defaults) != `{"agent":"codex","model":"gpt-5.6"}` {
		t.Fatalf("patched %+v err %v", got, err)
	}
	bad := jsonRaw(`{"agent":"sh"}`)
	if _, err := s.Update(context.Background(), v.ID, Patch{Defaults: &bad}); err == nil {
		t.Fatal("an agent Caprock cannot start was accepted as a default")
	}
	unknown := jsonRaw(`{"command":"sh"}`)
	if _, err := s.Update(context.Background(), v.ID, Patch{Defaults: &unknown}); err == nil {
		t.Fatal("an unknown default was accepted")
	}
	if _, err := s.Update(context.Background(), 999, Patch{Name: &name}); !errors.Is(err, store.ErrProjectNotFound) {
		t.Fatalf("unknown id: %v", err)
	}
}

// A project's instructions are stored trimmed, read back for any folder
// inside it — a worktree too — and for no folder outside it.
func TestProjectSystemPrompt(t *testing.T) {
	needGit(t)
	repo := newRepo(t, filepath.Join(t.TempDir(), "p"))
	s, _, _ := newService(t)
	start(t, s)
	v, _, _ := s.Add(context.Background(), repo)
	if got := s.SystemPrompt(repo); got != "" {
		t.Fatalf("a new project has instructions: %q", got)
	}
	d := jsonRaw(`{"model":"claude-opus-5-5","system_prompt":"  Use the Makefile; never npm.\n"}`)
	if _, err := s.Update(context.Background(), v.ID, Patch{Defaults: &d}); err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{repo, filepath.Join(repo, "internal", "api")} {
		if got := s.SystemPrompt(dir); got != "Use the Makefile; never npm." {
			t.Errorf("%s: %q", dir, got)
		}
	}
	if got := s.SystemPrompt(t.TempDir()); got != "" {
		t.Errorf("a folder outside every project got %q", got)
	}
	long := jsonRaw(`{"system_prompt":"` + strings.Repeat("x", SystemPromptMax+1) + `"}`)
	if _, err := s.Update(context.Background(), v.ID, Patch{Defaults: &long}); err == nil {
		t.Fatal("instructions over the limit were accepted")
	}
}

func TestParseStatus(t *testing.T) {
	g := parseStatus([]byte("# branch.oid abc\n# branch.head feat/x\n# branch.upstream origin/feat/x\n# branch.ab +2 -3\n1 .M N... 100644 100644 100644 a b f\n? new\n"))
	if g.Branch != "feat/x" || g.Ahead != 2 || g.Behind != 3 || g.Changed != 2 || !g.Dirty || g.Upstream != "origin/feat/x" {
		t.Fatalf("%+v", g)
	}
	g = parseStatus([]byte("# branch.oid abc\n# branch.head (detached)\n"))
	if !g.Detached || g.Branch != "" || g.Dirty {
		t.Fatalf("%+v", g)
	}
	if p, pct, ok := parseProgress("Receiving objects:  45% (450/1000), 1.2 MiB | 2 MiB/s"); !ok || p != "Receiving objects" || pct != 45 {
		t.Fatalf("%q %d %v", p, pct, ok)
	}
	if _, _, ok := parseProgress("Cloning into 'x'..."); ok {
		t.Fatal("not a progress line")
	}
}

func jsonRaw(s string) json.RawMessage { return json.RawMessage(s) }

// A destination typed in full may name folders that do not exist yet, as
// `git clone url a/b/c` allows; and ~ is the home folder, as in a terminal.
func TestCloneMakesMissingParentsAndExpandsHome(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	if got := expandHome("~/dev/x"); !sameDir(got, filepath.Join(home, "dev", "x")) {
		t.Fatalf("expandHome = %q", got)
	}
	if got := expandHome("/abs/~/x"); got != "/abs/~/x" {
		t.Fatalf("expandHome touched a non-leading ~: %q", got)
	}
	s, _, _ := newService(t)
	start(t, s)
	op, _, err := s.Clone("op-mk", "https://example.invalid/src", "~/dev/new", "")
	if err != nil {
		t.Fatalf("clone into a missing parent: %v", err)
	}
	if !sameDir(op.Dest, filepath.Join(home, "dev", "new", "src")) {
		t.Fatalf("dest %q", op.Dest)
	}
	if st, err := os.Stat(filepath.Join(home, "dev", "new")); err != nil || !st.IsDir() {
		t.Fatalf("parent not created: %v", err)
	}
}
