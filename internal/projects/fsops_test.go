package projects

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// fsFixture is a listed repository with a linked worktree "wt-agent" on
// its own branch, the agent having committed one change and added a file.
type fsFixture struct {
	changesFixture
	wt string
}

func newFsFixture(t *testing.T) fsFixture {
	t.Helper()
	f := fsFixture{changesFixture: newChangesFixture(t)}
	write(t, filepath.Join(f.repo, "src", "app.go"), "package app\n\nfunc A() int { return 1 }\n")
	write(t, filepath.Join(f.repo, "src", "same.go"), "package app\n")
	write(t, filepath.Join(f.repo, ".gitignore"), "build/\n")
	git(t, f.repo, "add", "-A")
	git(t, f.repo, "commit", "-q", "-m", "src")
	f.wt = filepath.Join(filepath.Dir(f.repo), "wt-agent")
	git(t, f.repo, "worktree", "add", "-q", "-b", "agent", f.wt)
	write(t, filepath.Join(f.wt, "src", "app.go"), "package app\n\nfunc A() int { return 2 }\n")
	git(t, f.wt, "commit", "-q", "-am", "agent change")
	write(t, filepath.Join(f.wt, "src", "new.go"), "package app\n// new\n")
	write(t, filepath.Join(f.repo, "notes.txt"), "mine\n")
	write(t, filepath.Join(f.repo, "build", "out.bin"), "x")
	write(t, filepath.Join(f.wt, "build", "out.bin"), "y")
	return f
}

func names(es []FsEntry) []string {
	out := []string{}
	for _, e := range es {
		n := e.Name
		if e.Dir {
			n += "/"
		}
		if e.Git != "" {
			n += " " + e.Git
		}
		out = append(out, n)
	}
	return out
}

func TestListDirFoldersFirstWithGitMarks(t *testing.T) {
	f := newFsFixture(t)
	ctx := context.Background()
	write(t, filepath.Join(f.repo, "f"), "changed\n")
	l, err := f.s.ListDir(ctx, f.id, "", "")
	if err != nil {
		t.Fatal(err)
	}
	got := strings.Join(names(l.Entries), ",")
	want := ".git/,build/ !,src/,.gitignore,f M,notes.txt ?"
	if got != want {
		t.Fatalf("root:\n got %s\nwant %s", got, want)
	}
	if !l.Git || l.Branch != "main" || l.Root == "" {
		t.Fatalf("listing: %+v", l)
	}
	sub, err := f.s.ListDir(ctx, f.id, "wt-agent", "src")
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(names(sub.Entries), ","); got != "app.go,new.go ?,same.go" {
		t.Fatalf("worktree src: %s", got)
	}
	if sub.Branch != "agent" {
		t.Fatalf("branch: %q", sub.Branch)
	}
}

// Nothing outside the root is reachable: not by .., not by an absolute
// path, not through a symlink, and on Windows not by a backslash or a
// drive letter.
func TestFsPathsStayInsideTheRoot(t *testing.T) {
	f := newFsFixture(t)
	ctx := context.Background()
	bad := []string{"..", "../wt-agent", "/etc", "src/../..", "src//app.go", "./src"}
	if runtime.GOOS == "windows" {
		bad = append(bad, `src\app.go`, `..\x`, `C:/Windows`, `C:x`, `\\server\share`)
	}
	for _, p := range bad {
		if _, err := f.s.ListDir(ctx, f.id, "", p); err == nil {
			t.Errorf("listed %q", p)
		}
		if _, err := f.s.DiffFile(ctx, f.id, "", "wt-agent", p); err == nil {
			t.Errorf("diffed %q", p)
		}
		if _, err := f.s.Trash(ctx, f.id, "", []string{p}); err == nil {
			t.Errorf("trashed %q", p)
		}
		if _, err := f.s.Copy(ctx, f.id, "", []string{"notes.txt"}, "wt-agent", p, false); err == nil {
			t.Errorf("copied into %q", p)
		}
	}
	if runtime.GOOS == "windows" {
		return // symlinks need a privilege there
	}
	outside := t.TempDir()
	write(t, filepath.Join(outside, "secret"), "s")
	if err := os.Symlink(outside, filepath.Join(f.repo, "out")); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.ListDir(ctx, f.id, "", "out"); !errors.Is(err, ErrFileEscape) {
		t.Fatalf("listed through a link out: %v", err)
	}
	if _, err := f.s.Copy(ctx, f.id, "", []string{"out/secret"}, "wt-agent", "", false); err == nil {
		t.Fatal("copied a file through a link out")
	}
	if _, err := f.s.Copy(ctx, f.id, "", []string{"notes.txt"}, "", "out", false); err == nil {
		t.Fatal("copied into a link out")
	}
	// The link itself may go; what it points at stays.
	l, _ := f.s.ListDir(ctx, f.id, "", "")
	for _, e := range l.Entries {
		if e.Name == "out" && (!e.Link || !e.Dir) {
			t.Fatalf("link entry: %+v", e)
		}
	}
}

func TestCompareDirAcrossWorktrees(t *testing.T) {
	f := newFsFixture(t)
	ctx := context.Background()
	c, err := f.s.CompareDir(ctx, f.id, "", "wt-agent", "")
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{"src": "diff", "notes.txt": "left"}
	for k, v := range want {
		if c.States[k] != v {
			t.Errorf("%s: %q, want %q (%v)", k, c.States[k], v, c.States)
		}
	}
	if c.States[".gitignore"] != "" || c.States["f"] != "" || c.States[".git"] != "" {
		t.Errorf("same files marked: %v", c.States)
	}
	if strings.Join(c.Unknown, ",") != "build" {
		t.Errorf("ignored folder: %v", c.Unknown)
	}
	sub, err := f.s.CompareDir(ctx, f.id, "", "wt-agent", "src")
	if err != nil {
		t.Fatal(err)
	}
	if sub.States["app.go"] != "diff" || sub.States["new.go"] != "right" || sub.States["same.go"] != "" {
		t.Fatalf("src: %v", sub.States)
	}
	// An ignored file is compared by its bytes.
	b, _ := f.s.CompareDir(ctx, f.id, "", "wt-agent", "build")
	if b.States["out.bin"] != "diff" {
		t.Fatalf("build: %v", b.States)
	}
}

func TestChangedSinceTheBase(t *testing.T) {
	f := newFsFixture(t)
	ctx := context.Background()
	write(t, filepath.Join(f.wt, "src", "same.go"), "package app\n// edited\n")
	c, err := f.s.Changed(ctx, f.id, "wt-agent", "")
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, x := range c.Changes {
		got = append(got, x.Status+" "+x.Path)
	}
	if strings.Join(got, ",") != "modified src/app.go,untracked src/new.go,modified src/same.go" {
		t.Fatalf("changed: %v", got)
	}
	// Main's own uncommitted change is not the agent's.
	write(t, filepath.Join(f.repo, "f"), "main's\n")
	c2, _ := f.s.Changed(ctx, f.id, "wt-agent", "")
	if len(c2.Changes) != len(c.Changes) {
		t.Fatalf("main's change counted as the agent's: %v", c2.Changes)
	}
}

func TestDiffFileAcrossRoots(t *testing.T) {
	f := newFsFixture(t)
	ctx := context.Background()
	d, err := f.s.DiffFile(ctx, f.id, "", "wt-agent", "src/app.go")
	if err != nil {
		t.Fatal(err)
	}
	if d.Additions != 1 || d.Deletions != 1 || !strings.Contains(d.Patch, "-func A() int { return 1 }\n+func A() int { return 2 }") || !strings.HasPrefix(d.Patch, "@@ -1,3 +1,3 @@") {
		t.Fatalf("patch: %+v\n%s", d, d.Patch)
	}
	n, err := f.s.DiffFile(ctx, f.id, "", "wt-agent", "src/new.go")
	if err != nil || n.Left || !n.Right || n.Additions != 2 || n.Deletions != 0 {
		t.Fatalf("new file: %v %+v", err, n)
	}
	s, _ := f.s.DiffFile(ctx, f.id, "", "wt-agent", "src/same.go")
	if !s.Same {
		t.Fatalf("same: %+v", s)
	}
	write(t, filepath.Join(f.repo, "bin"), "a\x00b")
	write(t, filepath.Join(f.wt, "bin"), "a\x00c")
	b, _ := f.s.DiffFile(ctx, f.id, "", "wt-agent", "bin")
	if !b.Binary || b.Patch != "" {
		t.Fatalf("binary: %+v", b)
	}
	if _, err := f.s.DiffFile(ctx, f.id, "", "wt-agent", "missing"); !errors.Is(err, ErrNoFile) {
		t.Fatalf("missing: %v", err)
	}
}

func TestCopyIntoTheOtherCheckout(t *testing.T) {
	f := newFsFixture(t)
	ctx := context.Background()
	if _, err := f.s.Copy(ctx, f.id, "wt-agent", []string{"src/new.go"}, "", "src", false); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(f.repo, "src", "new.go")); string(b) != "package app\n// new\n" {
		t.Fatalf("copied: %q", b)
	}
	// A taken name: nothing written, the names said.
	_, err := f.s.Copy(ctx, f.id, "wt-agent", []string{"src/app.go"}, "", "src", false)
	var ex *ExistsError
	if !errors.As(err, &ex) || strings.Join(ex.Names, ",") != "app.go" {
		t.Fatalf("exists: %v", err)
	}
	if b, _ := os.ReadFile(filepath.Join(f.repo, "src", "app.go")); !strings.Contains(string(b), "return 1") {
		t.Fatal("a refused copy wrote")
	}
	if _, err := f.s.Copy(ctx, f.id, "wt-agent", []string{"src/app.go"}, "", "src", true); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(f.repo, "src", "app.go")); !strings.Contains(string(b), "return 2") {
		t.Fatal("overwrite did not replace")
	}
	// A folder, recursively.
	if _, err := f.s.Copy(ctx, f.id, "wt-agent", []string{"src"}, "", "build", false); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(f.repo, "build", "src", "new.go")); err != nil {
		t.Fatal(err)
	}
	// Never onto itself or into itself, never git's own.
	if _, err := f.s.Copy(ctx, f.id, "", []string{"src"}, "", "", true); err == nil {
		t.Fatal("copied onto itself")
	}
	if _, err := f.s.Copy(ctx, f.id, "", []string{"src"}, "", "src", false); err == nil {
		t.Fatal("copied into itself")
	}
	if _, err := f.s.Copy(ctx, f.id, "", []string{".git"}, "", "build", false); err == nil {
		t.Fatal("copied .git")
	}
}

func TestMoveRenameAndMkdir(t *testing.T) {
	f := newFsFixture(t)
	ctx := context.Background()
	if _, err := f.s.Mkdir(ctx, f.id, "", "", "docs"); err != nil {
		t.Fatal(err)
	}
	var ex *ExistsError
	if _, err := f.s.Mkdir(ctx, f.id, "", "", "docs"); !errors.As(err, &ex) {
		t.Fatalf("mkdir twice: %v", err)
	}
	for _, bad := range []string{"", ".", "..", "a/b", `a\b`, "a:b", "end.", "end ", "q?"} {
		if _, err := f.s.Mkdir(ctx, f.id, "", "", bad); err == nil {
			t.Errorf("made %q", bad)
		}
	}
	if _, err := f.s.Move(ctx, f.id, "", []string{"notes.txt"}, "", "docs", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(f.repo, "docs", "notes.txt")); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.Move(ctx, f.id, "", []string{"docs/notes.txt"}, "", "docs", "Notes.md"); err != nil {
		t.Fatal(err)
	}
	// A case-only rename is allowed, even where the disk ignores case.
	if _, err := f.s.Move(ctx, f.id, "", []string{"docs/Notes.md"}, "", "docs", "NOTES.md"); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(f.repo, "docs", "other.md"), "o")
	if _, err := f.s.Move(ctx, f.id, "", []string{"docs/other.md"}, "", "docs", "NOTES.md"); !errors.As(err, &ex) {
		t.Fatalf("a move replaced a file: %v", err)
	}
	// Across checkouts.
	if _, err := f.s.Move(ctx, f.id, "", []string{"docs/other.md"}, "wt-agent", "", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(f.wt, "other.md")); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.Move(ctx, f.id, "", []string{"docs", "src"}, "", "", "x"); err == nil {
		t.Fatal("renamed two items to one name")
	}
}

func TestTrashGuards(t *testing.T) {
	f := newFsFixture(t)
	ctx := context.Background()
	// The worktree lives beside the repo here; one under the repo is the
	// usual place, and a folder with a .git is never trashed.
	inner := filepath.Join(f.repo, ".claude", "worktrees", "agent-x")
	git(t, f.repo, "worktree", "add", "-q", "-b", "agent-x", inner)
	for _, p := range []string{".git", ".git/config", ".claude/worktrees/agent-x"} {
		if _, err := f.s.Trash(ctx, f.id, "", []string{p}); err == nil {
			t.Errorf("trashed %s", p)
		}
		if _, err := f.s.Move(ctx, f.id, "", []string{p}, "", "build", ""); err == nil {
			t.Errorf("moved %s", p)
		}
	}
	if runtime.GOOS == "darwin" || runtime.GOOS == "windows" {
		if os.Getenv("CI") == "" && os.Getenv("CAPROCK_TEST_SYSTEM_TRASH") == "" {
			return
		}
	} else {
		t.Setenv("XDG_DATA_HOME", filepath.Join(t.TempDir(), "data"))
	}
	if _, err := f.s.Trash(ctx, f.id, "", []string{"notes.txt", "build"}); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{"notes.txt", "build"} {
		if _, err := os.Lstat(filepath.Join(f.repo, p)); err == nil {
			t.Fatalf("%s still there", p)
		}
	}
}

func TestUnifiedDiff(t *testing.T) {
	a := []string{"1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"}
	b := []string{"1", "2", "3", "four", "5", "6", "7", "8", "9", "10", "11", "12", "13"}
	p, add, del, _ := unified(a, b)
	want := "@@ -1,7 +1,7 @@\n 1\n 2\n 3\n-4\n+four\n 5\n 6\n 7\n@@ -10,3 +10,4 @@\n 10\n 11\n 12\n+13\n"
	if p != want || add != 2 || del != 1 {
		t.Fatalf("got\n%s(+%d −%d)\nwant\n%s", p, add, del, want)
	}
	p, add, del, _ = unified(nil, []string{"x"})
	if p != "@@ -0,0 +1,1 @@\n+x\n" || add != 1 || del != 0 {
		t.Fatalf("new file: %q", p)
	}
	p, _, del, _ = unified([]string{"x", "y"}, nil)
	if p != "@@ -1,2 +0,0 @@\n-x\n-y\n" || del != 2 {
		t.Fatalf("removed file: %q", p)
	}
}
