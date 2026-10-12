package projects

import (
	"context"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/agents"
)

// cleanupFixture is a repository with a remote and Caprock copies in every
// state the cleanup tells apart.
type cleanupFixture struct {
	s    *Service
	id   int64
	repo string
	// done are merged into main, pushed and clean: the candidates.
	done []string
	// squash is pushed, not merged in git, its pull request merged.
	squash   string
	dirty    string // merged, then an untracked file
	unmerged string // committed and pushed, not merged
	fresh    string // never committed in
	running  string // merged, a session in it
	handMade string // merged, made by hand
	mode     *modeBox
	now      *clock
}

type modeBox struct {
	mu sync.Mutex
	m  string
}

func (b *modeBox) get() string  { b.mu.Lock(); defer b.mu.Unlock(); return b.m }
func (b *modeBox) set(m string) { b.mu.Lock(); b.m = m; b.mu.Unlock() }

type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) get() time.Time      { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *clock) add(d time.Duration) { c.mu.Lock(); c.t = c.t.Add(d); c.mu.Unlock() }

func commitIn(t *testing.T, dir, name string) {
	t.Helper()
	write(t, filepath.Join(dir, name), name+"\n")
	git(t, dir, "add", name)
	git(t, dir, "commit", "-q", "-m", name)
}

func newCleanupFixture(t *testing.T) cleanupFixture {
	t.Helper()
	needGit(t)
	base := t.TempDir()
	remote := filepath.Join(base, "remote.git")
	if err := os.MkdirAll(remote, 0o755); err != nil {
		t.Fatal(err)
	}
	git(t, remote, "init", "-q", "--bare")
	repo := newRepo(t, filepath.Join(base, "repo"))
	git(t, repo, "remote", "add", "origin", remote)
	git(t, repo, "push", "-q", "origin", "main")
	hand := filepath.Join(base, "hand")
	git(t, repo, "worktree", "add", "-q", "-b", "hand", hand)
	commitIn(t, hand, "h.txt")
	git(t, repo, "merge", "-q", "--no-ff", "-m", "merge hand", "hand")

	s, _, _ := newService(t)
	f := cleanupFixture{s: s, repo: repo, handMade: hand, mode: &modeBox{m: CleanupAsk}, now: &clock{t: time.Now()}}
	s.CleanupMode = f.mode.get
	s.Now = f.now.get
	s.CleanupFile = filepath.Join(base, "data", CleanupStateFile)
	start(t, s)
	ctx := context.Background()
	v, _, err := s.Add(ctx, repo)
	if err != nil {
		t.Fatal(err)
	}
	f.id = v.ID
	mk := func(branch string) string {
		wt, err := s.AddWorktree(ctx, v.ID, agents.WorktreeSpec{Branch: branch, Create: true})
		if err != nil {
			t.Fatal(err)
		}
		return wt.Path
	}
	merged := func(branch string) string {
		p := mk(branch)
		commitIn(t, p, branch+".txt")
		git(t, p, "push", "-q", "origin", branch)
		git(t, repo, "merge", "-q", "--no-ff", "-m", "merge "+branch, branch)
		return p
	}
	for _, b := range []string{"done-a", "done-b", "done-c"} {
		f.done = append(f.done, merged(b))
	}
	f.dirty = merged("dirty")
	write(t, filepath.Join(f.dirty, "scratch.txt"), "unsaved\n")
	f.running = merged("running")
	f.unmerged = mk("unmerged")
	commitIn(t, f.unmerged, "u.txt")
	git(t, f.unmerged, "push", "-q", "origin", "unmerged")
	f.squash = mk("squash")
	commitIn(t, f.squash, "s.txt")
	git(t, f.squash, "push", "-q", "origin", "squash")
	f.fresh = mk("fresh")
	git(t, repo, "push", "-q", "origin", "main")
	squashHead := git(t, f.squash, "rev-parse", "HEAD")
	s.PRState = func(_, branch string) (string, int, string) {
		if branch == "squash" {
			return "merged", 42, squashHead
		}
		return "", 0, ""
	}
	// The remote URL comes from the project's git state; the fake ignores it.
	s.mu.Lock()
	if g := s.git[f.id]; g != nil {
		g.status.RemoteURL = "https://github.com/o/r.git"
	}
	s.mu.Unlock()
	running := f.running
	s.Busy = func(context.Context) BusyFunc {
		return func(dir string, _ []string) []string {
			if sameFolder(dir, running) {
				return []string{"a session"}
			}
			return nil
		}
	}
	return f
}

func candidatePaths(v CleanupView) []string {
	var out []string
	for _, c := range v.Candidates {
		out = append(out, filepath.Base(c.Path))
	}
	sort.Strings(out)
	return out
}

func TestCleanupFindsOnlyFinishedCopies(t *testing.T) {
	f := newCleanupFixture(t)
	ctx := context.Background()
	v, err := f.s.Cleanup(ctx, f.id)
	if err != nil {
		t.Fatal(err)
	}
	got := strings.Join(candidatePaths(v), ",")
	if got != "done-a,done-b,done-c,squash" {
		t.Fatalf("candidates %q; want the three merged copies and the squash-merged one (never dirty, unmerged, fresh, running, hand-made)", got)
	}
	if v.Mode != CleanupAsk || len(v.Removed) != 0 || len(v.History) != 0 {
		t.Fatalf("view: %+v", v)
	}
	for _, c := range v.Candidates {
		if c.Branch == "squash" && c.PR != 42 {
			t.Errorf("squash candidate names no pull request: %+v", c)
		}
		if c.Due != 0 {
			t.Errorf("Ask mode set a due time: %+v", c)
		}
	}
	// Ask mode removes nothing on its own.
	f.now.add(48 * time.Hour)
	if err := f.s.CheckCleanup(ctx, f.id); err != nil {
		t.Fatal(err)
	}
	for _, p := range f.done {
		if !exists(p) {
			t.Fatalf("Ask mode removed %s", p)
		}
	}
}

func TestCleanupOffFindsNothing(t *testing.T) {
	f := newCleanupFixture(t)
	f.mode.set(CleanupOff)
	v, err := f.s.Cleanup(context.Background(), f.id)
	if err != nil {
		t.Fatal(err)
	}
	if len(v.Candidates) != 0 || v.Mode != CleanupOff {
		t.Fatalf("off: %+v", v)
	}
	if _, err := f.s.CleanUp(context.Background(), f.id, f.done); err == nil {
		t.Fatal("Clean up ran with the cleanup off")
	}
}

func TestCleanUpRemovesExactlyThoseAsked(t *testing.T) {
	f := newCleanupFixture(t)
	ctx := context.Background()
	if _, err := f.s.Cleanup(ctx, f.id); err != nil {
		t.Fatal(err)
	}
	res, err := f.s.CleanUp(ctx, f.id, []string{f.done[0], f.done[1], f.dirty, f.handMade})
	if err != nil {
		t.Fatal(err)
	}
	removed := 0
	for _, r := range res {
		if r.Removed {
			removed++
		} else if r.Error == "" {
			t.Errorf("kept without a reason: %+v", r)
		}
	}
	if removed != 2 || exists(f.done[0]) || exists(f.done[1]) {
		t.Fatalf("want the two asked-for finished copies gone: %+v", res)
	}
	if !exists(f.done[2]) || !exists(f.dirty) || !exists(f.handMade) {
		t.Fatal("removed a copy not asked for, a dirty one or a hand-made one")
	}
	// The branches stay for Restore.
	git(t, f.repo, "rev-parse", "--verify", "refs/heads/done-a")
	v, _ := f.s.Cleanup(ctx, f.id)
	if len(v.History) != 2 || v.History[0].How != cleanupHowAsk || !v.History[0].Restorable {
		t.Fatalf("history: %+v", v.History)
	}
	if len(v.Removed) != 2 {
		t.Fatalf("want both on the Undo line: %+v", v.Removed)
	}
	if strings.Join(candidatePaths(v), ",") != "done-c,squash" {
		t.Fatalf("left: %v", candidatePaths(v))
	}
}

func TestCleanupAutoWaitsADayThenRemovesAndRestores(t *testing.T) {
	f := newCleanupFixture(t)
	f.mode.set(CleanupAuto)
	ctx := context.Background()
	if err := f.s.CheckCleanup(ctx, f.id); err != nil {
		t.Fatal(err)
	}
	for _, p := range f.done {
		if !exists(p) {
			t.Fatal("Auto removed a copy before its day was up")
		}
	}
	f.now.add(cleanupGrace + time.Minute)
	if err := f.s.CheckCleanup(ctx, f.id); err != nil {
		t.Fatal(err)
	}
	for _, p := range append(append([]string{}, f.done...), f.squash) {
		if exists(p) {
			t.Fatalf("Auto kept %s after its day", p)
		}
	}
	for _, p := range []string{f.dirty, f.unmerged, f.fresh, f.running, f.handMade} {
		if !exists(p) {
			t.Fatalf("Auto removed %s, which was never finished", p)
		}
	}
	v, _ := f.s.Cleanup(ctx, f.id)
	if len(v.Removed) != 4 || len(v.Candidates) != 0 {
		t.Fatalf("want 4 on the Undo line, none left: %+v", v)
	}
	// Undo: every one comes back from its kept branch.
	var ids []string
	for _, r := range v.Removed {
		ids = append(ids, r.ID)
	}
	res, err := f.s.Restore(ctx, f.id, ids)
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range res {
		if !r.Restored {
			t.Fatalf("restore: %+v", r)
		}
	}
	for _, p := range f.done {
		if !exists(filepath.Join(p, "f")) {
			t.Fatalf("%s not restored", p)
		}
	}
	// A restored copy is not finished again until its HEAD moves.
	f.now.add(cleanupGrace + time.Minute)
	if err := f.s.CheckCleanup(ctx, f.id); err != nil {
		t.Fatal(err)
	}
	if !exists(f.done[0]) {
		t.Fatal("a restored copy was removed again")
	}
	v, _ = f.s.Cleanup(ctx, f.id)
	if len(v.Removed) != 0 || len(v.Candidates) != 0 {
		t.Fatalf("after undo: %+v", v)
	}
	if r, err := f.s.Restore(ctx, f.id, ids[:1]); err != nil || len(r) != 1 || r[0].Restored || r[0].Error == "" {
		t.Fatalf("restored twice: %+v %v", r, err)
	}
}

func TestCleanupRestoreWithoutTheBranch(t *testing.T) {
	f := newCleanupFixture(t)
	ctx := context.Background()
	head := git(t, f.done[0], "rev-parse", "HEAD")
	res, err := f.s.RemoveCopies(ctx, f.id, []CopyRemoval{{Path: f.done[0]}}, true, nil)
	if err != nil || len(res) != 1 || !res[0].Removed || res[0].BranchDeleted != "done-a" {
		t.Fatalf("manual removal with its branch: %+v %v", res, err)
	}
	v, _ := f.s.Cleanup(ctx, f.id)
	if len(v.History) != 1 || v.History[0].How != cleanupManual || !v.History[0].BranchDeleted || !v.History[0].Restorable {
		t.Fatalf("history: %+v", v.History)
	}
	r, err := f.s.Restore(ctx, f.id, []string{v.History[0].ID})
	if err != nil || len(r) != 1 || !r[0].Restored {
		t.Fatalf("restore: %+v %v", r, err)
	}
	if got := git(t, f.done[0], "rev-parse", "HEAD"); got != head {
		t.Fatalf("restored at %s, want %s", got, head)
	}
	if got := git(t, f.done[0], "branch", "--show-current"); got != "done-a" {
		t.Fatalf("restored on %q", got)
	}
}

func TestCleanupDeletesTheBranchAfterAWeek(t *testing.T) {
	f := newCleanupFixture(t)
	ctx := context.Background()
	if _, err := f.s.Cleanup(ctx, f.id); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.CleanUp(ctx, f.id, []string{f.done[0], f.done[1]}); err != nil {
		t.Fatal(err)
	}
	// One branch moved on since: it is kept for good.
	git(t, f.repo, "branch", "-f", "done-b", "main")
	f.now.add(cleanupKeep - time.Hour)
	f.s.settleBranches(ctx)
	git(t, f.repo, "rev-parse", "--verify", "refs/heads/done-a")
	f.now.add(2 * time.Hour)
	f.s.settleBranches(ctx)
	if out, err := runGit(ctx, time.Minute, f.repo, "branch", "--list", "done-a"); err != nil || strings.TrimSpace(string(out)) != "" {
		t.Fatalf("done-a kept after the week: %q %v", out, err)
	}
	git(t, f.repo, "rev-parse", "--verify", "refs/heads/done-b")
	v, _ := f.s.Cleanup(ctx, f.id)
	for _, r := range v.History {
		if r.Restorable {
			t.Fatalf("restorable after the week: %+v", r)
		}
	}
}

func TestCleanupStateSurvivesARestart(t *testing.T) {
	f := newCleanupFixture(t)
	ctx := context.Background()
	f.mode.set(CleanupAuto)
	if err := f.s.CheckCleanup(ctx, f.id); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(f.s.CleanupFile)
	if err != nil || !strings.Contains(string(b), "done-a") {
		t.Fatalf("state file: %s %v", b, err)
	}
	// A new service reading the same file keeps each candidate's start, so a
	// restart does not reset the day.
	s2, _, _ := newService(t)
	s2.CleanupFile = f.s.CleanupFile
	c := s2.cleaner()
	if len(c.file.Since) != 4 {
		t.Fatalf("since after reload: %+v", c.file.Since)
	}
}

func TestCopiesMarksStaleCopies(t *testing.T) {
	f := newCleanupFixture(t)
	f.now.add(cleanupStaleAfter + time.Hour)
	v, err := f.s.Copies(context.Background(), f.id, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range v.Copies {
		want := c.Caprock && c.Branch != "squash" // the squash branch has a pull request
		if c.Stale != want {
			t.Errorf("%s: stale %v, want %v", c.Branch, c.Stale, want)
		}
	}
}

func TestCleanupBranchesMergedChecksTheProject(t *testing.T) {
	f := newCleanupFixture(t)
	old := cleanupSettle
	cleanupSettle = 10 * time.Millisecond
	t.Cleanup(func() { cleanupSettle = old })
	f.s.refreshNow(f.id)
	f.s.CleanupBranchesMerged([]string{"squash"})
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		c := f.s.cleaner()
		c.mu.Lock()
		_, ok := c.checked[f.id]
		c.mu.Unlock()
		if ok {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("a merged pull request did not check the project")
}

func TestInCopy(t *testing.T) {
	if !inCopy(filepath.Join("r", agents.WorktreeDir, "x")) || !inCopy(`C:\r\.caprock-worktrees\x\sub`) || inCopy("/r/src") {
		t.Fatal("inCopy")
	}
}
