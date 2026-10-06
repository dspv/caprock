package projects

import (
	"context"
	"strings"
	"testing"
)

// A remote is added once, under a plain name, to an https:// or git@ address.
func TestAddRemote(t *testing.T) {
	f := newChangesFixture(t)
	ctx := context.Background()
	if _, err := f.s.AddRemote(ctx, f.id, "origin", "https://github.com/ada/x.git"); kindOf(err) != KindState || !strings.Contains(err.Error(), "exists already") {
		t.Fatalf("over an existing origin: %v", err)
	}
	for _, c := range []struct{ name, url string }{
		{"-x", "https://github.com/ada/x.git"},
		{"up", "/local/path"},
		{"up", "ext::sh -c x"},
		{"up", "https://github.com/a b"},
	} {
		if _, err := f.s.AddRemote(ctx, f.id, c.name, c.url); kindOf(err) != KindInvalid {
			t.Errorf("AddRemote(%q, %q): %v", c.name, c.url, err)
		}
	}
	c, err := f.s.AddRemote(ctx, f.id, "upstream", "git@github.com:ada/x.git")
	if err != nil {
		t.Fatal(err)
	}
	if got := git(t, f.repo, "remote", "get-url", "upstream"); got != "git@github.com:ada/x.git" || c.Remote != "origin" {
		t.Fatalf("%q %+v", got, c)
	}
}

// The subjects a pull request is drafted from: the branch's commits that
// the remote's base lacks, newest first.
func TestSubjects(t *testing.T) {
	f := newChangesFixture(t)
	ctx := context.Background()
	git(t, f.repo, "checkout", "-q", "-b", "feat/x")
	git(t, f.repo, "commit", "-q", "--allow-empty", "-m", "first")
	git(t, f.repo, "commit", "-q", "--allow-empty", "-m", "second")
	got, err := f.s.Subjects(ctx, f.id, "", "main")
	if err != nil || strings.Join(got, ",") != "second,first" {
		t.Fatalf("%v %v", got, err)
	}
	if got, _ := f.s.Subjects(ctx, f.id, "", "no-such-branch"); len(got) != 0 {
		t.Fatalf("unknown base: %v", got)
	}
	if got, _ := f.s.Subjects(ctx, f.id, "", "--all"); len(got) != 0 {
		t.Fatalf("an option as base: %v", got)
	}
}
