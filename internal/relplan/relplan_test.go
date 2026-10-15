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
	got := parseBatch([]byte(out))
	if len(got) != 3 || string(got[0]) != "hello" || len(got[1]) != 0 || string(got[2]) != "a\nb" {
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
		AddFragment(&fu, f)
	}
	if fu.Count != 2 || fu.Items[0] != "**a:** first by name." || fu.Items[1] != "**b:** second." {
		t.Fatalf("fragment items = %+v", fu)
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
