package branches

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// landedRepo is a repository on main with one file, a git helper and a
// writer.
func landedRepo(t *testing.T) (string, func(...string), func(string, string)) {
	t.Helper()
	dir := gitRepo(t)
	g := func(args ...string) {
		t.Helper()
		mustGit(t, dir, append([]string{"-c", "user.name=Ada", "-c", "user.email=ada@example.com", "-c", "commit.gpgsign=false"}, args...)...)
	}
	write := func(name, body string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(filepath.Join(dir, name)), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	g("checkout", "-q", "main")
	write("app.go", app(1, 2, 3))
	g("add", "-A")
	g("commit", "-q", "-m", "chore: the app")
	return dir, g, write
}

// app is a file of three functions far enough apart that changing one
// leaves the others' hunks whole.
func app(a, b, c int) string {
	f := func(name string, v int) string {
		return "func " + name + "() int {\n\t// " + name + ".\n\t// More of " + name + ".\n\treturn " + strconv.Itoa(v) + "\n}\n"
	}
	return "package app\n\n" + f("A", a) + "\n// --\n// --\n// --\n\n" + f("B", b) + "\n// --\n// --\n// --\n\n" + f("C", c)
}

func landedOf(t *testing.T, dir, branch string) bool {
	t.Helper()
	sha := strings.TrimSpace(mustGit(t, dir, "rev-parse", branch))
	ok, err := Landed(context.Background(), dir, "main", sha)
	if err != nil {
		t.Fatalf("%s: %v", branch, err)
	}
	return ok
}

// The owner's release plan listed branches already shipped (2026-10-19):
// squash-merged, after which main edited the same file and a release
// consumed the branch's changelog fragment, so merging it no longer gave
// main's own tree. Its hunks are still found in main's history.
func TestLandedAfterSquashAndLaterEdits(t *testing.T) {
	dir, g, write := landedRepo(t)
	g("checkout", "-q", "-b", "fix/a")
	write("app.go", app(10, 2, 3))
	write("changes/unreleased/fix-a.md", "- A is ten.\n")
	g("add", "-A")
	g("commit", "-q", "-m", "fix(app): A returns ten")
	g("checkout", "-q", "-b", "fix/unshipped", "main")
	write("app.go", app(1, 20, 3))
	g("commit", "-q", "-am", "fix(app): B returns twenty")

	g("checkout", "-q", "main")
	g("merge", "-q", "--squash", "fix/a")
	g("commit", "-q", "-m", "a squash whose message names nothing")
	// Later work on main: the same file, then a release taking the fragment,
	// then the same file again.
	write("app.go", app(10, 2, 30))
	g("commit", "-q", "-am", "feat(app): C returns thirty")
	g("rm", "-q", "changes/unreleased/fix-a.md")
	g("commit", "-q", "-m", "chore(release): 1.0.0")
	write("app.go", strings.Replace(app(10, 2, 30), "package app\n", "// Package app.\npackage app\n", 1))
	g("commit", "-q", "-am", "docs(app): say what the package is")

	if !landedOf(t, dir, "fix/a") {
		t.Fatal("fix/a: shipped by a squash, edited since, not landed")
	}
	if landedOf(t, dir, "fix/unshipped") {
		t.Fatal("fix/unshipped: main never had it, called landed")
	}
	// Asked again, the kept answer.
	if !landedOf(t, dir, "fix/a") {
		t.Fatal("kept answer differs")
	}
}

// A batch: two branches squashed into one commit whose message names
// neither, found by content; and one whose review fix rewrote the branch's
// line, found by its subject in GitHub's "* subject" list.
func TestLandedInsideABatch(t *testing.T) {
	dir, g, write := landedRepo(t)
	g("checkout", "-q", "-b", "fix/one")
	write("one.txt", "one\n")
	g("add", "-A")
	g("commit", "-q", "-m", "feat(one): the first file of the batch")
	g("checkout", "-q", "-b", "fix/two", "main")
	write("app.go", app(1, 2, 33))
	g("commit", "-q", "-am", "fix(app): C returns thirty-three")
	g("checkout", "-q", "-b", "batch/1", "main")
	g("merge", "-q", "--no-edit", "fix/one", "fix/two")

	g("checkout", "-q", "main")
	g("merge", "-q", "--squash", "batch/1")
	g("commit", "-q", "-m", "fix: the batch")
	write("one.txt", "one\nand more\n")
	write("app.go", app(11, 2, 33))
	g("commit", "-q", "-am", "docs: grow one, A is eleven")
	for _, b := range []string{"fix/one", "fix/two"} {
		if !landedOf(t, dir, b) {
			t.Fatalf("%s: inside the batch, not landed", b)
		}
	}

	g("checkout", "-q", "-b", "fix/three")
	write("three.txt", "three\n")
	g("add", "-A")
	g("commit", "-q", "-m", "feat(three): a third file for the batch")
	g("checkout", "-q", "main")
	write("three.txt", "three, as reviewed\n")
	g("add", "-A")
	g("commit", "-q", "-m", "fix: the second batch (#10)\n\n* feat(three): a third file for the batch\n\n* fix: review")
	if !landedOf(t, dir, "fix/three") {
		t.Fatal("fix/three: named in the batch's squash, not landed")
	}
}

// A short subject names too many commits to go by.
func TestLandedNotByAShortSubject(t *testing.T) {
	dir, g, write := landedRepo(t)
	g("checkout", "-q", "-b", "wip")
	write("w.txt", "w\n")
	g("add", "-A")
	g("commit", "-q", "-m", "wip")
	g("checkout", "-q", "main")
	write("other.txt", "other\n")
	g("add", "-A")
	g("commit", "-q", "-m", "wip")
	if landedOf(t, dir, "wip") {
		t.Fatal("a short subject on main called the branch landed")
	}
}

func TestHolds(t *testing.T) {
	file := "a\nb\nc\nd\n"
	for _, c := range []struct {
		hunks [][]string
		want  bool
	}{
		{[][]string{{"b", "c"}}, true},
		{[][]string{{"a"}, {"c", "d", ""}}, true},
		{[][]string{{"c"}, {"a"}}, false}, // out of order
		{[][]string{{"b", "d"}}, false},
	} {
		if got := holds(file, c.hunks); got != c.want {
			t.Errorf("holds(%v) = %v, want %v", c.hunks, got, c.want)
		}
	}
}
