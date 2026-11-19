package relplan

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestParseUnreleased(t *testing.T) {
	cases := []struct {
		name  string
		in    string
		ok    bool
		items []string
		count int
	}{
		{name: "missing", in: "# Changelog\n\n## [1.0.0]\n\n- one\n", ok: false},
		{name: "empty", in: "# Changelog\n\n## [Unreleased]\n\n## [1.0.0]\n\n- shipped\n", ok: true},
		{
			name: "nested and continuation lines dropped",
			in: "## [Unreleased]\n\n### Added\n\n- **a:** first line\n  goes on here\n  - nested\n    - deeper\n* **b:** second\n\n### Fixed\n\n- **c:** third\n\n" +
				"## [1.0.0] - 2026-01-01\n\n- old\n",
			ok: true, items: []string{"**a:** first line", "**b:** second", "**c:** third"}, count: 3,
		},
		{name: "crlf", in: "## [Unreleased]\r\n\r\n- one\r\n- two\r\n## [0.1.0]\r\n- old\r\n", ok: true, items: []string{"one", "two"}, count: 2},
		{name: "heading with a suffix", in: "## [Unreleased] - not yet dated\n- one\n", ok: true, items: []string{"one"}, count: 1},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			u, ok := ParseUnreleased([]byte(c.in))
			if ok != c.ok || u.Count != c.count || strings.Join(u.Items, "|") != strings.Join(c.items, "|") {
				t.Fatalf("got %+v ok=%v, want items %q count %d ok=%v", u, ok, c.items, c.count, c.ok)
			}
		})
	}
}

// More than MaxItems: the first thirty are returned and the count is whole.
func TestParseUnreleasedCapsItems(t *testing.T) {
	var b strings.Builder
	b.WriteString("## [Unreleased]\n")
	for i := 0; i < 45; i++ {
		fmt.Fprintf(&b, "- item %d\n", i)
	}
	u, ok := ParseUnreleased([]byte(b.String()))
	if !ok || u.Count != 45 || len(u.Items) != MaxItems || u.Items[29] != "item 29" {
		t.Fatalf("got count %d, %d items", u.Count, len(u.Items))
	}
}

func TestAddFragment(t *testing.T) {
	var u Unreleased
	AddFragment(&u, []byte("---\nkind: Added\n---\n- **ui:** one.\n  more.\n  - nested\n- **ui:** two.\n"))
	AddFragment(&u, []byte("- **bare:** no front matter.\n"))
	want := []string{"**ui:** one.", "**ui:** two.", "**bare:** no front matter."}
	if u.Count != 3 || fmt.Sprint(u.Items) != fmt.Sprint(want) {
		t.Fatalf("got %+v", u)
	}
}

func TestParseBatch(t *testing.T) {
	out := "abc blob 5\nhello\nmissing-ref missing\ndef blob 0\n\nxyz blob 3\na\nb\n"
	got := parseBatch([]byte(out), []string{"d/one.md", "d/gone.md", "d/two.md", "d/three.md"})
	if len(got) != 3 || string(got[0].Body) != "hello" || len(got[1].Body) != 0 || string(got[2].Body) != "a\nb" ||
		got[0].Name != "one.md" || got[1].Name != "two.md" || got[2].Name != "three.md" {
		t.Fatalf("got %q", got)
	}
}

func TestMedianGap(t *testing.T) {
	day := int64(24 * time.Hour / time.Millisecond)
	tags := func(days ...int64) []Tag {
		var out []Tag
		for i, d := range days {
			out = append(out, Tag{Name: fmt.Sprint("v", i), At: d * day})
		}
		return out
	}
	// Two gaps: not enough.
	if m, n := MedianGap(tags(10, 8, 7)); m != 0 || n != 2 {
		t.Fatalf("two gaps: %d over %d", m, n)
	}
	// Three gaps of 1, 2, 4 days, newest first as git lists them.
	if m, n := MedianGap(tags(17, 13, 11, 10)); m != 2*day || n != 3 {
		t.Fatalf("three gaps: %d over %d", m, n)
	}
	// Four gaps 1, 1, 3, 5: the mean of the middle two. Two tags on one
	// commit at one moment are one release.
	if m, n := MedianGap(tags(20, 15, 12, 12, 11, 10)); m != 2*day || n != 4 {
		t.Fatalf("four gaps: %d over %d", m, n)
	}
}

func TestParseTags(t *testing.T) {
	got := ParseTags("v0.2.0\t1700000100\r\nbroken\nv0.1.0\t1700000000\nv0\tx\n")
	if len(got) != 2 || got[0] != (Tag{"v0.2.0", 1700000100000}) || got[1].Name != "v0.1.0" {
		t.Fatalf("tags = %+v", got)
	}
}

// Against a real clone: the default branch is read from origin/HEAD without
// a fetch, the CHANGELOG from that branch (not the work tree), the newest
// tags, and how far the branch is past the last one.
func TestReadsAClone(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	ctx := context.Background()
	root := t.TempDir()
	up := filepath.Join(root, "up")
	if err := os.Mkdir(up, 0o755); err != nil {
		t.Fatal(err)
	}
	base := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	commit := func(n int, at time.Time) {
		t.Helper()
		body := fmt.Sprintf("# Changelog\n\n## [Unreleased]\n\n- change %d\n\n## [0.1.0]\n\n- first\n", n)
		if err := os.WriteFile(filepath.Join(up, "CHANGELOG.md"), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		gitAt(t, up, at, "add", "CHANGELOG.md")
		gitAt(t, up, at, "commit", "-q", "-m", fmt.Sprint("c", n))
	}
	gitAt(t, up, base, "init", "-q", "-b", "main")
	for i, days := range []int{0, 1, 3, 7} {
		at := base.AddDate(0, 0, days)
		commit(i, at)
		gitAt(t, up, at, "tag", fmt.Sprintf("v0.%d.0", i))
	}
	commit(10, base.AddDate(0, 0, 8))
	fragDir := filepath.Join(up, "changes", "unreleased")
	if err := os.MkdirAll(fragDir, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]string{
		"b.md":     "---\nkind: Fixed\n---\n- **b:** second.\n",
		"a.md":     "---\r\nkind: Added\r\n---\r\n- **a:** first by name.\r\n  continued.\r\n",
		".gitkeep": "",
		"note.txt": "- not a fragment\n",
	} {
		if err := os.WriteFile(filepath.Join(fragDir, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	gitAt(t, up, base, "add", "changes")
	commit(11, base.AddDate(0, 0, 9))
	gitAt(t, root, base, "clone", "-q", up, "clone")
	clone := filepath.Join(root, "clone")
	// The work tree's own CHANGELOG is not what is read.
	if err := os.WriteFile(filepath.Join(clone, "CHANGELOG.md"), []byte("## [Unreleased]\n- local only\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	if u, err := OriginURL(ctx, clone); err != nil || u == "" {
		t.Fatalf("origin %q err %v", u, err)
	}
	ref, sha, err := DefaultRef(ctx, clone)
	if err != nil || ref != "origin/main" || len(sha) < 40 {
		t.Fatalf("ref %q sha %q err %v", ref, sha, err)
	}
	cl, ok := Changelog(ctx, clone, sha)
	if !ok {
		t.Fatal("no CHANGELOG at the default branch")
	}
	if u, ok := ParseUnreleased(cl); !ok || u.Count != 1 || u.Items[0] != "change 11" {
		t.Fatalf("unreleased = %+v", u)
	}
	frags, ok := Fragments(ctx, clone, sha)
	if !ok || len(frags) != 2 {
		t.Fatalf("fragments = %q ok %v", frags, ok)
	}
	var fu Unreleased
	for _, f := range frags {
		AddFragmentFile(&fu, f.Name, f.Body)
	}
	if fu.Count != 2 || fu.Items[0] != "**a:** first by name." || fu.Items[1] != "**b:** second." || fu.Kinds["Added"] != 1 || fu.Kinds["Fixed"] != 1 {
		t.Fatalf("fragment items = %+v", fu)
	}
	if e := fu.Entries[0]; e.Text != "first by name. continued." || e.Scope != "a" || e.Kind != "Added" || e.File != "a.md" {
		t.Fatalf("fragment entry = %+v", e)
	}
	if _, ok := Fragments(ctx, up, "v0.0.0"); ok {
		t.Fatal("a commit without changes/unreleased read fragments")
	}
	tags, err := Tags(ctx, clone)
	if err != nil || len(tags) != 4 || tags[0].Name != "v0.3.0" || tags[0].At != base.AddDate(0, 0, 7).UnixMilli() {
		t.Fatalf("tags = %+v err %v", tags, err)
	}
	if m, n := MedianGap(tags); n != 3 || m != int64(2*24*time.Hour/time.Millisecond) {
		t.Fatalf("gap %d over %d", m, n)
	}
	if n, err := Ahead(ctx, clone, tags[0].Name, sha); err != nil || n != 2 {
		t.Fatalf("ahead %d err %v", n, err)
	}

	// A repository with no remote has no default branch to read.
	if _, _, err := DefaultRef(ctx, up); !errors.Is(err, ErrNoRef) {
		t.Fatalf("no remote: %v", err)
	}
	if _, ok := Changelog(ctx, clone, "no-such-ref"); ok {
		t.Fatal("a missing ref read a CHANGELOG")
	}
}

// emptyConfig is an empty file standing for the global config: os.DevNull
// is NUL on Windows, which is not a path to read as a file.
func emptyConfig(t *testing.T) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "config")
	if err := os.WriteFile(p, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

// gitAt runs git with author and committer dates fixed, so the tags' dates
// are known; global and system config are kept out.
func gitAt(t *testing.T, dir string, at time.Time, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir, "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false"}, args...)...)
	stamp := at.Format(time.RFC3339)
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t",
		"GIT_AUTHOR_DATE="+stamp, "GIT_COMMITTER_DATE="+stamp, "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL="+emptyConfig(t))
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

// The kinds are counted from the section's ### headings and the fragments'
// front matter: the release plan reads an Added entry as a minor release.
func TestKinds(t *testing.T) {
	u, ok := ParseUnreleased([]byte("## [Unreleased]\n\n- before any heading\n\n### Added\n\n- **a:** one\n- **a:** two\n\n### Notes\n\n- not a kind\n\n### fixed\n\n- **c:** three\n\n## [1.0.0]\n\n### Added\n\n- old\n"))
	if !ok || u.Count != 5 || u.Kinds["Added"] != 2 || u.Kinds["Fixed"] != 1 || len(u.Kinds) != 2 {
		t.Fatalf("section: got %+v", u)
	}
	var f Unreleased
	AddFragment(&f, []byte("---\nkind: Fixed\n---\n- **x:** fix.\n"))
	AddFragment(&f, []byte("---\r\nkind:  added \r\n---\r\n- **y:** one.\r\n- **y:** two.\r\n"))
	AddFragment(&f, []byte("- **bare:** no kind.\n"))
	AddFragment(&f, []byte("---\nkind: Whatever\n---\n- **z:** unknown kind.\n"))
	if f.Count != 5 || f.Kinds["Fixed"] != 1 || f.Kinds["Added"] != 2 || len(f.Kinds) != 2 {
		t.Fatalf("fragments: got %+v", f)
	}
	var none Unreleased
	AddFragment(&none, []byte("- **bare:** no kind.\n"))
	if none.Kinds != nil {
		t.Fatalf("no kind: got %+v", none.Kinds)
	}
}

// Release notes say a bullet whole, in plain words: the scope apart, the
// continuation lines joined, emphasis, code ticks and link targets dropped.
func TestPlain(t *testing.T) {
	for _, c := range []struct{ in, scope, text string }{
		{"**ui:** folded, the *CI* section's `second` line", "ui", "folded, the CI section's second line"},
		{"no scope, **bold** and a [link](https://x.example)", "", "no scope, bold and a link"},
		{"**a b:** snake_case_name stays * alone", "a b", "snake_case_name stays * alone"},
		{"**ui:**   spaced   out  ", "ui", "spaced out"},
	} {
		if scope, text := Plain(c.in); scope != c.scope || text != c.text {
			t.Errorf("Plain(%q) = %q, %q; want %q, %q", c.in, scope, text, c.scope, c.text)
		}
	}
	_, long := Plain(strings.Repeat("ab ", 200))
	if r := []rune(long); len(r) > EntryRunes || len(r) < EntryRunes-2 || !strings.HasSuffix(long, "…") {
		t.Fatalf("long: %d runes %q", len(r), long[len(long)-8:])
	}
}

func TestEntries(t *testing.T) {
	u, ok := ParseUnreleased([]byte("## [Unreleased]\n\n### Fixed\n\n- **ui:** one\n  goes on.\n  - nested\n  not this.\n- **ui:** two\n\n## [1.0.0]\n- old\n"))
	if !ok || len(u.Entries) != 2 || u.Entries[0] != (Entry{Text: "one goes on.", Scope: "ui", Kind: "Fixed"}) || u.Entries[1].Text != "two" {
		t.Fatalf("entries = %+v", u.Entries)
	}
	if fmt.Sprint(u.Items) != "[**ui:** one **ui:** two]" {
		t.Fatalf("items = %q", u.Items)
	}
}

// The newest released section: the first versioned heading after
// [Unreleased], its entries grouped as written.
func TestParseRelease(t *testing.T) {
	v, u, ok := ParseRelease([]byte("# Changelog\n\n## [Unreleased]\n\n- pending\n\n## [0.183.0] - 2026-11-19\n\n### Added\n\n- **a:** new\n\n### Fixed\n\n- **b:** fixed\n\n## [0.182.0]\n\n- older\n"))
	if !ok || v != "0.183.0" || u.Count != 2 || u.Entries[0].Kind != "Added" || u.Entries[1] != (Entry{Text: "fixed", Scope: "b", Kind: "Fixed"}) {
		t.Fatalf("release %q %+v ok %v", v, u, ok)
	}
	if _, _, ok := ParseRelease([]byte("## [Unreleased]\n- only\n")); ok {
		t.Fatal("no released section read one")
	}
}

// The batch pull request's branch, as the clone knows it: its fragments are
// read from origin/<branch> without a fetch, and only those it added past
// where it left the default branch.
func TestReadsABatchBranch(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	ctx := context.Background()
	root := t.TempDir()
	up := filepath.Join(root, "up")
	if err := os.MkdirAll(filepath.Join(up, FragmentsDir), 0o755); err != nil {
		t.Fatal(err)
	}
	at := time.Date(2026, 11, 19, 12, 0, 0, 0, time.UTC)
	write := func(name, body string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(up, FragmentsDir, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		gitAt(t, up, at, "add", "-A")
		gitAt(t, up, at, "commit", "-q", "-m", name)
	}
	gitAt(t, up, at, "init", "-q", "-b", "master")
	write("old.md", "---\nkind: Fixed\n---\n- **x:** on master.\n")
	gitAt(t, up, at, "checkout", "-q", "-b", "feat/batch")
	write("new.md", "---\nkind: Changed\n---\n- **y:** in the batch.\n")
	gitAt(t, up, at, "checkout", "-q", "master")
	gitAt(t, root, at, "clone", "-q", up, "clone")
	clone := filepath.Join(root, "clone")

	head, ok := RemoteBranch(ctx, clone, "feat/batch")
	if !ok || len(head) < 40 {
		t.Fatalf("origin/feat/batch: %q %v", head, ok)
	}
	if _, ok := RemoteBranch(ctx, clone, "feat/never-pushed"); ok {
		t.Fatal("a branch the clone does not know was read")
	}
	_, master, err := DefaultRef(ctx, clone)
	if err != nil {
		t.Fatal(err)
	}
	base, ok := MergeBase(ctx, clone, master, head)
	if !ok || base != master {
		t.Fatalf("merge base %q, master %q", base, master)
	}
	names, ok := FragmentNames(ctx, clone, head)
	if !ok || fmt.Sprint(names) != "[changes/unreleased/new.md changes/unreleased/old.md]" {
		t.Fatalf("names %q ok %v", names, ok)
	}
	frags, ok := ReadFragments(ctx, clone, head, names[:1])
	if !ok || len(frags) != 1 || frags[0].Name != "new.md" || !strings.Contains(string(frags[0].Body), "in the batch") {
		t.Fatalf("frags %+v", frags)
	}
}
