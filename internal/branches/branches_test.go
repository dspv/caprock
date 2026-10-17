package branches

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestParseAheadBehind(t *testing.T) {
	for in, want := range map[string][2]int{"3 1": {3, 1}, "0 0\n": {0, 0}, " 12\t7 ": {12, 7}} {
		a, b := ParseAheadBehind(in)
		if a == nil || b == nil || *a != want[0] || *b != want[1] {
			t.Fatalf("ParseAheadBehind(%q) = %v %v, want %v", in, a, b, want)
		}
	}
	for _, in := range []string{"", "3", "a b", "1 2 3", "-1 2"} {
		if a, b := ParseAheadBehind(in); a != nil || b != nil {
			t.Fatalf("ParseAheadBehind(%q) = %v %v, want nothing", in, a, b)
		}
	}
}

func TestParseRefsAndMerge(t *testing.T) {
	out := strings.Join([]string{
		"refs/heads/main\taaa\t1700000000\tAda\t0 0",
		"refs/heads/feat/x\tbbb\t1700000100\tBo\t2 1",
		"refs/remotes/origin/HEAD\taaa\t1700000000\tAda\t0 0",
		"refs/remotes/origin/main\taaa\t1700000000\tAda\t0 0",
		"refs/remotes/origin/feat/x\tccc\t1690000000\tBo\t1 1",
		"refs/remotes/origin/only-remote\tddd\t1700000200\tCy\t4 0",
		"refs/remotes/upstream/elsewhere\teee\t1700000300\tDi\t1 0",
		"refs/tags/v1\tfff\t1700000400\tEd",
		"short\tline",
		"",
	}, "\r\n")
	bs := merge(parseRefs(out))
	if len(bs) != 3 {
		t.Fatalf("branches = %+v, want main, feat/x, only-remote", bs)
	}
	by := map[string]Branch{}
	for _, b := range bs {
		by[b.Name] = b
	}
	x := by["feat/x"]
	// The local branch wins over origin's copy of it.
	if !x.Local || !x.Remote || x.SHA != "bbb" || x.CommittedMS != 1700000100000 || x.Author != "Bo" || *x.Ahead != 2 || *x.Behind != 1 {
		t.Fatalf("feat/x = %+v", x)
	}
	r := by["only-remote"]
	if r.Local || !r.Remote || *r.Ahead != 4 || r.Author != "Cy" {
		t.Fatalf("only-remote = %+v", r)
	}
	// Without the ahead-behind field nothing is counted.
	bs = merge(parseRefs("refs/heads/main\taaa\t1700000000\tAda\n"))
	if len(bs) != 1 || bs[0].Ahead != nil || bs[0].Behind != nil {
		t.Fatalf("uncounted = %+v", bs)
	}
}

func TestIsStale(t *testing.T) {
	now := time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC)
	old := Branch{Name: "old", CommittedMS: now.Add(-31 * 24 * time.Hour).UnixMilli()}
	fresh := Branch{Name: "fresh", CommittedMS: now.Add(-29 * 24 * time.Hour).UnixMilli()}
	if !IsStale(old, false, now) {
		t.Fatal("31 days without a commit and no open PR is stale")
	}
	if IsStale(old, true, now) {
		t.Fatal("an open PR keeps a branch from being stale")
	}
	if IsStale(fresh, false, now) {
		t.Fatal("29 days is not stale")
	}
	old.Default = true
	if IsStale(old, false, now) {
		t.Fatal("the default branch is never stale")
	}
	if IsStale(Branch{Name: "unknown"}, false, now) {
		t.Fatal("no commit time is not stale")
	}
}

// gitRepo makes a repository: main with two commits, feat/a one commit ahead
// and one behind, old with a commit 40 days back, feat/a checked out.
func gitRepo(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	dir := t.TempDir()
	run := func(date string, args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir, "-c", "user.name=Ada", "-c", "user.email=ada@example.com", "-c", "commit.gpgsign=false"}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_DATE="+date, "GIT_COMMITTER_DATE="+date)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	now := time.Now().UTC()
	d := func(ago time.Duration) string { return now.Add(-ago).Format(time.RFC3339) }
	run(d(50*24*time.Hour), "init", "-q", "-b", "main")
	run(d(50*24*time.Hour), "commit", "-q", "--allow-empty", "-m", "one")
	run(d(40*24*time.Hour), "checkout", "-q", "-b", "old")
	run(d(40*24*time.Hour), "commit", "-q", "--allow-empty", "-m", "old work")
	run(d(2*time.Hour), "checkout", "-q", "main")
	run(d(2*time.Hour), "checkout", "-q", "-b", "feat/a")
	run(d(2*time.Hour), "commit", "-q", "--allow-empty", "-m", "a")
	run(d(time.Hour), "checkout", "-q", "main")
	run(d(time.Hour), "commit", "-q", "--allow-empty", "-m", "two")
	run(d(time.Hour), "checkout", "-q", "feat/a")
	return dir
}

func TestListCountsAgainstTheDefaultBranch(t *testing.T) {
	dir := gitRepo(t)
	l, err := List(context.Background(), dir, "")
	if err != nil {
		t.Fatal(err)
	}
	if l.Default != "main" || l.Base != "main" || l.Current != "feat/a" {
		t.Fatalf("listing = %+v", l)
	}
	by := map[string]Branch{}
	for _, b := range l.Branches {
		by[b.Name] = b
	}
	a := by["feat/a"]
	if !a.Current || a.Ahead == nil || *a.Ahead != 1 || *a.Behind != 1 || a.Author != "Ada" || !a.Local || a.Remote {
		t.Fatalf("feat/a = %+v", a)
	}
	if m := by["main"]; !m.Default || *m.Ahead != 0 || *m.Behind != 0 {
		t.Fatalf("main = %+v", m)
	}
	if o := by["old"]; *o.Ahead != 1 || *o.Behind != 1 || !IsStale(o, false, time.Now()) {
		t.Fatalf("old = %+v", o)
	}
	// The one-by-one count, for a git without %(ahead-behind:), agrees.
	bs := merge(parseRefs(mustGit(t, dir, "for-each-ref", "--format="+refFormat(""), "refs/heads")))
	countEach(context.Background(), dir, "main", bs)
	for _, b := range bs {
		w := by[b.Name]
		if b.Ahead == nil || *b.Ahead != *w.Ahead || *b.Behind != *w.Behind {
			t.Fatalf("%s counted %v/%v, want %v/%v", b.Name, b.Ahead, b.Behind, *w.Ahead, *w.Behind)
		}
	}
	if _, err := List(context.Background(), t.TempDir(), ""); err == nil {
		t.Fatal("a folder that is no repository listed branches")
	}
}

// A branch's last commit subject is read with it, a tab in it kept; one whose
// work reached main by a squash merge is landed by content, one with work
// main lacks is not (owner, 2026-10-18: pushed branches in the release plan).
func TestSubjectAndLandedByContent(t *testing.T) {
	dir := gitRepo(t)
	g := func(args ...string) {
		t.Helper()
		mustGit(t, dir, append([]string{"-c", "user.name=Ada", "-c", "user.email=ada@example.com", "-c", "commit.gpgsign=false"}, args...)...)
	}
	write := func(name, body string) {
		t.Helper()
		if err := os.WriteFile(dir+"/"+name, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	g("checkout", "-q", "main")
	g("checkout", "-q", "-b", "feat/squashed")
	write("a.txt", "one\n")
	g("add", "a.txt")
	g("commit", "-q", "-m", "add a")
	write("a.txt", "one\ntwo\n")
	g("commit", "-q", "-am", "grow a\twith a tab")
	g("checkout", "-q", "-b", "feat/open", "main")
	write("b.txt", "b\n")
	g("add", "b.txt")
	g("commit", "-q", "-m", "add b")
	// main takes feat/squashed's work as one squashed commit.
	g("checkout", "-q", "main")
	g("merge", "-q", "--squash", "feat/squashed")
	g("commit", "-q", "-m", "feat: a (#1)")

	l, err := list(context.Background(), dir, "main")
	if err != nil {
		t.Fatal(err)
	}
	by := map[string]Branch{}
	for _, b := range l.Branches {
		by[b.Name] = b
	}
	if s := by["feat/squashed"].Subject; s != "grow a\twith a tab" {
		t.Fatalf("subject = %q", s)
	}
	ctx := context.Background()
	if ok, err := Landed(ctx, dir, "main", by["feat/squashed"].SHA); err != nil || !ok {
		t.Fatalf("squashed: landed %v, %v", ok, err)
	}
	if ok, err := Landed(ctx, dir, "main", by["feat/open"].SHA); err != nil || ok {
		t.Fatalf("open: landed %v, %v", ok, err)
	}
	// Asked again, the kept answer.
	if ok, _ := Landed(ctx, dir, "main", by["feat/squashed"].SHA); !ok {
		t.Fatal("kept answer differs")
	}
}

func mustGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	out, err := git(context.Background(), dir, args...)
	if err != nil {
		t.Fatal(err)
	}
	return out
}
