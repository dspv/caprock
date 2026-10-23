package relplan

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestSubjectPR(t *testing.T) {
	for subject, want := range map[string]int{
		"feat(pipeline): most expensive (#801)":         801,
		"fix: a thing (#12)\r":                          12, // a CRLF line
		"Merge pull request #44 from dspv/feat/x":       44, // a merge commit, not squashed
		`Revert "feat: x (#12)" (#13)`:                  13,
		"chore: bump (#7) and more":                     0, // not at the end
		"Merge branch 'master' into feat/x":             0,
		"docs: no number":                               0,
		"chore(release): 0.151.0 (#800)   ":             800,
		"Merge pull request #0 from someone/branch-one": 0,
	} {
		if got := SubjectPR(subject); got != want {
			t.Errorf("SubjectPR(%q) = %d, want %d", subject, got, want)
		}
	}
}

func TestParseTagRefs(t *testing.T) {
	out := "v0.2.0\taaa\t\t1700000100\r\n" + // lightweight
		"v0.3.0\ttagobj\tccc\t1700000200\r\n" + // annotated: the peeled commit
		"v1.0.0-rc.1\tddd\t\t1700000300\n" + // a pre-release is not a release
		"app-v2.0.1\teee\t\t1700000400\n" +
		"broken line\n"
	want := []TagRef{{Name: "v0.2.0", Commit: "aaa", At: 1700000100000}, {Name: "v0.3.0", Commit: "ccc", At: 1700000200000}}
	if got := ParseTagRefs(out); !reflect.DeepEqual(got, want) {
		t.Fatalf("ParseTagRefs = %+v, want %+v", got, want)
	}
}

// Each commit's pull request goes to the first release at or after it; a
// merge commit and a squash both name one; a tag off the line is left out.
func TestParseReleases(t *testing.T) {
	log := "s9\tfeat: after the last release (#9)\r\n" +
		"s8\tchore(release): 0.3.0 (#8)\r\n" +
		"s7\tMerge pull request #7 from o/feat-x\r\n" +
		"s6\tfix: y (#6)\r\n" +
		"s5\tchore(release): 0.2.0 (#5)\n" +
		"s4\tfeat: z (#4)\n" +
		"s3\tdocs: no pull request\n" +
		"s2\tfeat: w (#2)\n"
	tags := []TagRef{
		{Name: "v0.2.0", Commit: "s5", At: 2000},
		{Name: "v0.3.0", Commit: "s8", At: 3000},
		{Name: "v0.2.1", Commit: "elsewhere", At: 2500}, // on another branch
	}
	got := ParseReleases(log, tags)
	want := []Release{
		{Tag: "v0.3.0", At: 3000, PRs: []int{6, 7, 8}},
		{Tag: "v0.2.0", At: 2000, PRs: []int{2, 4, 5}, First: true},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("ParseReleases = %+v, want %+v", got, want)
	}
	// Two version tags on one commit are one release, the higher version.
	got = ParseReleases(log, []TagRef{{Name: "v0.2.0", Commit: "s5", At: 2000}, {Name: "v0.10.0", Commit: "s5", At: 2000}})
	if len(got) != 1 || got[0].Tag != "v0.10.0" {
		t.Fatalf("two tags on a commit: %+v", got)
	}
	if got := ParseReleases(log, nil); len(got) != 0 {
		t.Fatalf("no tags: %+v", got)
	}
}

// A real checkout: tags, squash merges and a merge commit off a branch,
// read through git.
func TestReleaseHistoryFromAGitCheckout(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	dir := t.TempDir()
	at := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	git := func(args ...string) {
		t.Helper()
		at = at.Add(time.Minute)
		gitAt(t, dir, at, args...)
	}
	commit := func(msg string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, "f.txt"), []byte(msg), 0o600); err != nil {
			t.Fatal(err)
		}
		git("add", "f.txt")
		git("commit", "-q", "-m", msg)
	}
	git("init", "-q", "-b", "main")
	commit("feat: one (#1)")
	commit("chore(release): 0.1.0 (#2)")
	git("tag", "v0.1.0")
	git("checkout", "-q", "-b", "feat/x")
	commit("wip: inner commit (#99)") // on the branch: not first-parent of main
	git("checkout", "-q", "main")
	git("merge", "-q", "--no-ff", "-m", "Merge pull request #3 from o/feat-x", "feat/x")
	commit("fix: two (#4)")
	git("tag", "-a", "v0.2.0", "-m", "v0.2.0")
	git("tag", "v0.2.0-rc.1")
	commit("feat: unreleased (#5)")

	ctx := context.Background()
	key, ref, tagsOut, err := HistoryKey(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	if ref != "HEAD" || key == "" {
		t.Fatalf("no origin: ref = %q", ref)
	}
	got, err := ReleaseHistory(ctx, dir, ref, tagsOut)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].Tag != "v0.2.0" || !reflect.DeepEqual(got[0].PRs, []int{3, 4}) ||
		got[1].Tag != "v0.1.0" || !reflect.DeepEqual(got[1].PRs, []int{1, 2}) || !got[1].First || got[0].At <= got[1].At {
		t.Fatalf("ReleaseHistory = %+v", got)
	}
	// A new tag changes the key; nothing else read does.
	git("tag", "v0.3.0")
	key2, _, _, err := HistoryKey(ctx, dir)
	if err != nil || key2 == key {
		t.Fatalf("key did not move with a new tag: %v", err)
	}
}
