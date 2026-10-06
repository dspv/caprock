package projects

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// changeEnv is the environment the service's git runs with in these tests:
// an identity, and no global or system config, so the machine's own
// (hooksPath, signing) cannot change the result.
func changeEnv(home string) func() []string {
	return func() []string {
		return append(os.Environ(), "HOME="+home, "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL="+filepath.Join(home, "gitconfig"),
			"GIT_AUTHOR_NAME=Ada", "GIT_AUTHOR_EMAIL=ada@example.com", "GIT_COMMITTER_NAME=Ada", "GIT_COMMITTER_EMAIL=ada@example.com")
	}
}

type changesFixture struct {
	s    *Service
	id   int64
	repo string
	bare string
	home string
}

// newChangesFixture is a listed repository with one commit on main, pushed
// to a local bare remote it tracks.
func newChangesFixture(t *testing.T) changesFixture {
	t.Helper()
	needGit(t)
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	f := changesFixture{repo: filepath.Join(base, "repo"), bare: filepath.Join(base, "remote.git"), home: filepath.Join(base, "home")}
	_ = os.MkdirAll(f.home, 0o755)
	newRepo(t, f.repo)
	git(t, base, "init", "-q", "--bare", "-b", "main", f.bare)
	git(t, f.repo, "remote", "add", "origin", f.bare)
	git(t, f.repo, "push", "-q", "-u", "origin", "main")
	s, _, _ := newService(t)
	s.Env = changeEnv(f.home)
	start(t, s)
	v, _, err := s.Add(context.Background(), f.repo)
	if err != nil {
		t.Fatal(err)
	}
	f.s, f.id = s, v.ID
	return f
}

func write(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func kindOf(err error) string {
	var ce *ChangeError
	if errors.As(err, &ce) {
		return ce.Kind
	}
	return ""
}

func paths(fs []ChangeFile) []string {
	out := []string{}
	for _, f := range fs {
		out = append(out, f.Status+" "+f.Path)
	}
	return out
}

// The status says what is staged, what is not, what is new, with counts, a
// rename with its source, a binary file as binary, and where the branch
// stands against its upstream.
func TestChangesStatus(t *testing.T) {
	f := newChangesFixture(t)
	ctx := context.Background()
	write(t, filepath.Join(f.repo, "a.txt"), "one\ntwo\nthree\n")
	git(t, f.repo, "add", "a.txt")
	git(t, f.repo, "commit", "-q", "-m", "a")
	git(t, f.repo, "mv", "a.txt", "b.txt")
	write(t, filepath.Join(f.repo, "f"), "x\ny\n")
	write(t, filepath.Join(f.repo, "dir with space", "new file.txt"), "1\n2\n")
	write(t, filepath.Join(f.repo, "bin.dat"), "a\x00b")
	c, err := f.s.Changes(ctx, f.id, "")
	if err != nil {
		t.Fatal(err)
	}
	if c.Branch != "main" || c.Upstream != "origin/main" || c.Ahead != 1 || c.Behind != 0 || !c.Published || c.Remote != "origin" || c.Token == "" {
		t.Fatalf("branch state: %+v", c)
	}
	if got := strings.Join(paths(c.Staged), ","); got != "renamed b.txt" || c.Staged[0].OrigPath != "a.txt" {
		t.Fatalf("staged: %s %+v", got, c.Staged)
	}
	got := map[string]ChangeFile{}
	for _, x := range c.Unstaged {
		got[x.Path] = x
	}
	if x := got["f"]; x.Status != "modified" || x.Additions != 1 {
		t.Errorf("f: %+v", x)
	}
	if x := got["dir with space/new file.txt"]; x.Status != "untracked" || x.Additions != 2 {
		t.Errorf("new file: %+v", x)
	}
	if x := got["bin.dat"]; !x.Binary {
		t.Errorf("binary: %+v", x)
	}
	// The token moves with the status.
	write(t, filepath.Join(f.repo, "g"), "g\n")
	c2, _ := f.s.Changes(ctx, f.id, "")
	if c2.Token == c.Token {
		t.Error("token did not change with the status")
	}
}

// A file's diff: unstaged, staged (a rename named with its source), a new
// file against nothing, a binary file said to be one, and a huge one cut.
func TestChangesDiff(t *testing.T) {
	f := newChangesFixture(t)
	ctx := context.Background()
	write(t, filepath.Join(f.repo, "f"), "x\nadded\n")
	write(t, filepath.Join(f.repo, "new.txt"), "hello\n")
	write(t, filepath.Join(f.repo, "bin.dat"), "a\x00b")
	big := strings.Repeat("a line that makes the file large enough\n", 40000)
	write(t, filepath.Join(f.repo, "big.txt"), big)
	d, err := f.s.Diff(ctx, f.id, "", "f", false)
	if err != nil || !strings.Contains(d.Patch, "+added") || d.Token == "" || d.Status != "modified" {
		t.Fatalf("unstaged: %v %+v", err, d)
	}
	if _, err := f.s.Diff(ctx, f.id, "", "f", true); kindOf(err) != KindStale {
		t.Fatalf("staged diff of an unstaged file: %v", err)
	}
	n, err := f.s.Diff(ctx, f.id, "", "new.txt", false)
	if err != nil || !strings.Contains(n.Patch, "+hello") || strings.Contains(n.Patch, os.DevNull+" b/") || n.Status != "untracked" {
		t.Fatalf("untracked: %v %+v", err, n)
	}
	b, err := f.s.Diff(ctx, f.id, "", "bin.dat", false)
	if err != nil || !b.Binary {
		t.Fatalf("binary: %v %+v", err, b)
	}
	l, err := f.s.Diff(ctx, f.id, "", "big.txt", false)
	if err != nil || !l.Truncated || len(l.Patch) > MaxPatchBytes || l.Bytes <= MaxPatchBytes || !strings.HasSuffix(l.Patch, "\n") {
		t.Fatalf("large: %v truncated=%v len=%d bytes=%d", err, l.Truncated, len(l.Patch), l.Bytes)
	}
	git(t, f.repo, "mv", "f", "g")
	r, err := f.s.Diff(ctx, f.id, "", "g", true)
	if err != nil || r.OrigPath != "f" || r.Status != "renamed" || !strings.Contains(r.Patch, "rename from f") {
		t.Fatalf("staged rename: %v %+v", err, r)
	}
}

// A path is a path inside the worktree that git lists as changed, and
// nothing else: not absolute, not climbing out, not a pattern, not a file
// that has no change.
func TestChangesRefusePathsOutsideTheWorktree(t *testing.T) {
	f := newChangesFixture(t)
	ctx := context.Background()
	write(t, filepath.Join(f.repo, "f"), "changed\n")
	outside := filepath.Join(filepath.Dir(f.repo), "secret.txt")
	write(t, outside, "secret\n")
	for _, p := range []string{"", "/etc/passwd", outside, "../secret.txt", "a/../../secret.txt", "./f", "f/", "*", ":(top)f", "f\x00"} {
		if _, err := f.s.Diff(ctx, f.id, "", p, false); err == nil {
			t.Errorf("diff %q was served", p)
		}
		if _, err := f.s.Stage(ctx, f.id, "", []string{p}, false, nil); err == nil {
			t.Errorf("stage %q worked", p)
		}
		if _, _, err := f.s.Discard(ctx, f.id, "", []string{p}, ""); err == nil {
			t.Errorf("discard %q previewed", p)
		}
	}
	if _, err := f.s.Stage(ctx, f.id, "", []string{"f", "unchanged-file"}, false, nil); kindOf(err) != KindStale {
		t.Errorf("a file with no change: %v", err)
	}
	if _, err := f.s.Changes(ctx, f.id, "no-such-worktree"); !errors.Is(err, ErrNoWorktree) {
		t.Errorf("unknown worktree: %v", err)
	}
	if b, _ := os.ReadFile(outside); string(b) != "secret\n" {
		t.Fatal("a file outside the worktree changed")
	}
}

// Files go in and out of the index; so does one hunk, only while the patch
// is the one the caller saw.
func TestStageAndUnstage(t *testing.T) {
	f := newChangesFixture(t)
	ctx := context.Background()
	lines := []string{}
	for i := 0; i < 30; i++ {
		lines = append(lines, "line")
	}
	write(t, filepath.Join(f.repo, "f"), strings.Join(lines, "\n")+"\n")
	git(t, f.repo, "commit", "-q", "-am", "thirty lines")
	lines[1], lines[25] = "first change", "second change"
	write(t, filepath.Join(f.repo, "f"), strings.Join(lines, "\n")+"\n")
	write(t, filepath.Join(f.repo, "new.txt"), "n\n")

	c, err := f.s.Stage(ctx, f.id, "", []string{"new.txt"}, false, nil)
	if err != nil || strings.Join(paths(c.Staged), ",") != "added new.txt" {
		t.Fatalf("stage a file: %v %v", err, paths(c.Staged))
	}
	c, err = f.s.Unstage(ctx, f.id, "", []string{"new.txt"}, false, nil)
	if err != nil || len(c.Staged) != 0 {
		t.Fatalf("unstage a file: %v %v", err, paths(c.Staged))
	}
	d, _ := f.s.Diff(ctx, f.id, "", "f", false)
	if strings.Count(d.Patch, "\n@@") != 2 {
		t.Fatalf("want two hunks:\n%s", d.Patch)
	}
	if _, err := f.s.Stage(ctx, f.id, "", nil, false, &Hunk{Path: "f", Index: 1, Token: "stale"}); kindOf(err) != KindStale {
		t.Fatalf("a stale token staged a hunk: %v", err)
	}
	if _, err = f.s.Stage(ctx, f.id, "", nil, false, &Hunk{Path: "f", Index: 1, Token: d.Token}); err != nil {
		t.Fatal(err)
	}
	staged := git(t, f.repo, "diff", "--cached")
	if !strings.Contains(staged, "+second change") || strings.Contains(staged, "+first change") {
		t.Fatalf("the wrong hunk was staged:\n%s", staged)
	}
	sd, _ := f.s.Diff(ctx, f.id, "", "f", true)
	if _, err := f.s.Unstage(ctx, f.id, "", nil, false, &Hunk{Path: "f", Index: 0, Token: sd.Token}); err != nil {
		t.Fatal(err)
	}
	if out := git(t, f.repo, "diff", "--cached"); out != "" {
		t.Fatalf("the hunk stayed staged:\n%s", out)
	}
	if b, _ := os.ReadFile(filepath.Join(f.repo, "f")); !strings.Contains(string(b), "first change") || !strings.Contains(string(b), "second change") {
		t.Fatal("hunk staging touched the working tree")
	}
	if _, err := f.s.Stage(ctx, f.id, "", nil, true, nil); err != nil {
		t.Fatal(err)
	}
	c, _ = f.s.Unstage(ctx, f.id, "", nil, true, nil)
	if len(c.Staged) != 0 || len(c.Unstaged) != 2 {
		t.Fatalf("unstage all: %v / %v", paths(c.Staged), paths(c.Unstaged))
	}
}

// Discard asks twice; changes nothing on the first ask; refuses when a file
// changed in between; deletes a new file and restores an edited one; never
// touches what is staged.
func TestDiscardIsTwoStep(t *testing.T) {
	f := newChangesFixture(t)
	ctx := context.Background()
	write(t, filepath.Join(f.repo, "f"), "edited\n")
	write(t, filepath.Join(f.repo, "deep", "er", "new.txt"), "new\n")
	write(t, filepath.Join(f.repo, "keep.txt"), "staged\n")
	git(t, f.repo, "add", "keep.txt")

	if _, _, err := f.s.Discard(ctx, f.id, "", []string{"keep.txt"}, ""); kindOf(err) != KindStale {
		t.Fatalf("a staged-only file was offered for discard: %v", err)
	}
	pv, _, err := f.s.Discard(ctx, f.id, "", []string{"f", "deep/er/new.txt"}, "")
	if err != nil || pv == nil || pv.Confirm == "" || len(pv.Files) != 2 {
		t.Fatalf("preview: %v %+v", err, pv)
	}
	if b, _ := os.ReadFile(filepath.Join(f.repo, "f")); string(b) != "edited\n" {
		t.Fatal("the preview discarded")
	}
	// An agent writes after the look: the old token no longer holds.
	write(t, filepath.Join(f.repo, "f"), "edited again, more text\n")
	_, _, err = f.s.Discard(ctx, f.id, "", []string{"f", "deep/er/new.txt"}, pv.Confirm)
	var ce *ChangeError
	if !errors.As(err, &ce) || ce.Kind != KindStale || ce.Preview == nil || ce.Preview.Confirm == pv.Confirm {
		t.Fatalf("stale confirm: %v", err)
	}
	if b, _ := os.ReadFile(filepath.Join(f.repo, "f")); string(b) != "edited again, more text\n" {
		t.Fatal("a stale confirm discarded")
	}
	_, c, err := f.s.Discard(ctx, f.id, "", []string{"f", "deep/er/new.txt"}, ce.Preview.Confirm)
	if err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(f.repo, "f")); string(b) != "x\n" {
		t.Fatalf("f not restored: %q", b)
	}
	if _, err := os.Stat(filepath.Join(f.repo, "deep")); !os.IsNotExist(err) {
		t.Fatal("the new file's empty folders were left")
	}
	if strings.Join(paths(c.Staged), ",") != "added keep.txt" || len(c.Unstaged) != 0 {
		t.Fatalf("after: %v / %v", paths(c.Staged), paths(c.Unstaged))
	}
}

// A link planted in the path of a new file cannot steer a discard outside
// the worktree.
func TestDiscardDoesNotFollowALinkOut(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks need privileges on Windows")
	}
	f := newChangesFixture(t)
	ctx := context.Background()
	outside := filepath.Join(filepath.Dir(f.repo), "outside")
	write(t, filepath.Join(outside, "victim.txt"), "keep me\n")
	if err := os.Symlink(outside, filepath.Join(f.repo, "link")); err != nil {
		t.Skip(err)
	}
	// git lists the link itself, never what is behind it.
	pv, _, err := f.s.Discard(ctx, f.id, "", []string{"link"}, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := f.s.Discard(ctx, f.id, "", []string{"link/victim.txt"}, ""); err == nil {
		t.Fatal("a path through a link was offered")
	}
	if _, _, err := f.s.Discard(ctx, f.id, "", []string{"link"}, pv.Confirm); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(outside, "victim.txt")); string(b) != "keep me\n" {
		t.Fatal("a file outside the worktree was deleted")
	}
}

// A commit needs a message and something staged; it is made as the
// configured author; a hook's refusal comes back with its output and leaves
// the index as it was.
func TestCommit(t *testing.T) {
	f := newChangesFixture(t)
	ctx := context.Background()
	if _, _, err := f.s.Commit(ctx, f.id, "", "  \n ", false); kindOf(err) != KindInvalid {
		t.Fatalf("empty message: %v", err)
	}
	if _, _, err := f.s.Commit(ctx, f.id, "", "nothing", false); kindOf(err) != KindState {
		t.Fatalf("nothing staged: %v", err)
	}
	write(t, filepath.Join(f.repo, "f"), "y\n")
	write(t, filepath.Join(f.repo, "n.txt"), "n\n")
	res, c, err := f.s.Commit(ctx, f.id, "", "Change f\n\nAnd add n.", true)
	if err != nil {
		t.Fatal(err)
	}
	if res.Subject != "Change f" || len(res.SHA) != 40 || len(c.Staged)+len(c.Unstaged) != 0 || c.Ahead != 1 {
		t.Fatalf("commit: %+v %+v", res, c)
	}
	if who := git(t, f.repo, "log", "-1", "--format=%an <%ae>|%B"); who != "Ada <ada@example.com>|Change f\n\nAnd add n." {
		t.Fatalf("author or message: %q", who)
	}

	hook := filepath.Join(f.repo, ".git", "hooks", "pre-commit")
	write(t, hook, "#!/bin/sh\necho 'lint: 3 problems in f' >&2\nexit 1\n")
	if err := os.Chmod(hook, 0o755); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(f.repo, "f"), "z\n")
	git(t, f.repo, "add", "f")
	_, _, err = f.s.Commit(ctx, f.id, "", "Blocked", false)
	var ce *ChangeError
	if !errors.As(err, &ce) || ce.Kind != KindHook || !strings.Contains(ce.Output, "lint: 3 problems in f") {
		t.Fatalf("hook failure: %v %+v", err, ce)
	}
	c, _ = f.s.Changes(ctx, f.id, "")
	if strings.Join(paths(c.Staged), ",") != "modified f" {
		t.Fatalf("the index changed after a refused commit: %v", paths(c.Staged))
	}
	write(t, hook, "#!/bin/sh\necho 'lint: clean'\n")
	res, _, err = f.s.Commit(ctx, f.id, "", "Passes", false)
	if err != nil || !strings.Contains(res.Output, "lint: clean") {
		t.Fatalf("a passing hook's output: %v %q", err, res.Output)
	}
}

// Push: the first push of a new branch sets its upstream; a worktree made
// to track the trunk pushes its own branch, never the trunk; a remote that
// moved on is refused and never forced.
func TestPush(t *testing.T) {
	f := newChangesFixture(t)
	ctx := context.Background()
	git(t, f.repo, "checkout", "-q", "-b", "feat/x", "--track", "origin/main")
	write(t, filepath.Join(f.repo, "f"), "feature\n")
	git(t, f.repo, "commit", "-q", "-am", "feature")
	c, _ := f.s.Changes(ctx, f.id, "")
	if c.Published || c.Upstream != "origin/main" {
		t.Fatalf("before: %+v", c)
	}
	res, c, err := f.s.Push(ctx, f.id, "")
	if err != nil {
		t.Fatal(err)
	}
	if !res.UpstreamSet || c.Upstream != "origin/feat/x" || !c.Published || c.Ahead != 0 {
		t.Fatalf("first push: %+v %+v", res, c)
	}
	if main := git(t, f.bare, "log", "-1", "--format=%s", "main"); main != "init" {
		t.Fatalf("the trunk moved: %q", main)
	}
	if got := git(t, f.bare, "log", "-1", "--format=%s", "feat/x"); got != "feature" {
		t.Fatalf("remote feat/x: %q", got)
	}

	// Someone else pushes to feat/x.
	other := filepath.Join(filepath.Dir(f.repo), "other")
	git(t, filepath.Dir(f.repo), "clone", "-q", "-b", "feat/x", f.bare, other)
	write(t, filepath.Join(other, "o.txt"), "o\n")
	git(t, other, "add", "o.txt")
	git(t, other, "commit", "-q", "-m", "theirs")
	git(t, other, "push", "-q")
	write(t, filepath.Join(f.repo, "m.txt"), "m\n")
	git(t, f.repo, "add", "m.txt")
	git(t, f.repo, "commit", "-q", "-m", "mine")
	_, _, err = f.s.Push(ctx, f.id, "")
	if kindOf(err) != KindRejected {
		t.Fatalf("push over their commit: %v", err)
	}
	if got := git(t, f.bare, "log", "-1", "--format=%s", "feat/x"); got != "theirs" {
		t.Fatalf("their commit was overwritten: %q", got)
	}
	// Fetch sees it; a pull cannot fast-forward a branch that diverged.
	if _, c, err = f.s.Fetch(ctx, f.id, ""); err != nil || c.Behind != 1 || c.Ahead != 1 {
		t.Fatalf("fetch: %v %+v", err, c)
	}
	if _, _, err = f.s.Pull(ctx, f.id, ""); kindOf(err) != KindDiverged {
		t.Fatalf("pull a diverged branch: %v", err)
	}
}

// Pull fast-forwards when it can.
func TestPullFastForwards(t *testing.T) {
	f := newChangesFixture(t)
	ctx := context.Background()
	other := filepath.Join(filepath.Dir(f.repo), "other")
	git(t, filepath.Dir(f.repo), "clone", "-q", f.bare, other)
	write(t, filepath.Join(other, "o.txt"), "o\n")
	git(t, other, "add", "o.txt")
	git(t, other, "commit", "-q", "-m", "theirs")
	git(t, other, "push", "-q")
	_, c, err := f.s.Pull(ctx, f.id, "")
	if err != nil || c.Behind != 0 {
		t.Fatalf("pull: %v %+v", err, c)
	}
	if _, err := os.Stat(filepath.Join(f.repo, "o.txt")); err != nil {
		t.Fatal("not fast-forwarded")
	}
	git(t, f.repo, "checkout", "-q", "-b", "local-only")
	if _, _, err := f.s.Pull(ctx, f.id, ""); kindOf(err) != KindState {
		t.Fatalf("pull without upstream: %v", err)
	}
}

// A remote that asks for credentials, with no terminal to type them in,
// is an auth failure said as one, not a hang.
func TestPushAuthFailureIsNamed(t *testing.T) {
	f := newChangesFixture(t)
	ctx := context.Background()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("WWW-Authenticate", `Basic realm="git"`)
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()
	git(t, f.repo, "remote", "set-url", "origin", srv.URL+"/repo.git")
	_, _, err := f.s.Push(ctx, f.id, "")
	var ce *ChangeError
	if !errors.As(err, &ce) || ce.Kind != KindAuth || ce.Output == "" {
		t.Fatalf("auth failure: %v %+v", err, ce)
	}
	git(t, f.repo, "remote", "remove", "origin")
	if _, _, err := f.s.Push(ctx, f.id, ""); kindOf(err) != KindState {
		t.Fatalf("no remote: %v", err)
	}
}

// A linked worktree is addressed by its name, and its changes are its own.
func TestChangesInALinkedWorktree(t *testing.T) {
	f := newChangesFixture(t)
	ctx := context.Background()
	wt := filepath.Join(filepath.Dir(f.repo), "wt-feature")
	git(t, f.repo, "worktree", "add", "-q", "-b", "feature", wt)
	write(t, filepath.Join(wt, "f"), "in the worktree\n")
	c, err := f.s.Changes(ctx, f.id, "wt-feature")
	if err != nil || c.Branch != "feature" || len(c.Unstaged) != 1 || c.Path != wt {
		t.Fatalf("worktree: %v %+v", err, c)
	}
	main, _ := f.s.Changes(ctx, f.id, "")
	if len(main.Unstaged) != 0 {
		t.Fatalf("the main checkout shows the worktree's change: %v", paths(main.Unstaged))
	}
	if _, _, err := f.s.Commit(ctx, f.id, "wt-feature", "In the worktree", true); err != nil {
		t.Fatal(err)
	}
	if got := git(t, f.repo, "log", "-1", "--format=%s", "feature"); got != "In the worktree" {
		t.Fatalf("feature: %q", got)
	}
}

func TestParseStatusZ(t *testing.T) {
	raw := "# branch.oid abc\x00# branch.head main\x00# branch.upstream origin/main\x00# branch.ab +2 -1\x00" +
		"1 .M N... 100644 100644 100644 h1 h2 a file.txt\x00" +
		"2 R. N... 100644 100644 100644 h1 h2 R100 new name.txt\x00old name.txt\x00" +
		"u UU N... 100644 100644 100644 100644 h1 h2 h3 c.txt\x00" +
		"? dir/n.txt\x00"
	st := parseStatusZ([]byte(raw))
	if st.oid != "abc" || st.head != "main" || st.upstream != "origin/main" || st.ahead != 2 || st.behind != 1 || len(st.entries) != 4 {
		t.Fatalf("%+v", st)
	}
	if e := st.entries[1]; e.path != "new name.txt" || e.origPath != "old name.txt" || e.x != 'R' {
		t.Fatalf("rename: %+v", e)
	}
	if e := st.entries[0]; e.path != "a file.txt" || e.y != 'M' {
		t.Fatalf("modified: %+v", e)
	}
}

func TestClassifyRemote(t *testing.T) {
	for out, want := range map[string]string{
		"fatal: could not read Username for 'https://github.com': terminal prompts disabled": KindAuth,
		"git@github.com: Permission denied (publickey).\nfatal: Could not read from remote":  KindAuth,
		" ! [rejected]        main -> main (fetch first)":                                    KindRejected,
		"fatal: Not possible to fast-forward, aborting.":                                     KindDiverged,
		"ssh: Could not resolve hostname nowhere: nodename nor servname provided":            KindNetwork,
		"fatal: unable to access 'https://x/': Could not resolve host: x":                    KindNetwork,
		"something else entirely": KindGit,
	} {
		if got, _ := classifyRemote(out); got != want {
			t.Errorf("%q: %s, want %s", out, got, want)
		}
	}
}
