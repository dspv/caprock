package github

import (
	"context"
	"net/http"
	"strconv"
	"testing"
	"time"
)

func branchPull(n int, ref, state string, merged bool, headRepo string) apiPull {
	var p apiPull
	p.Number, p.HTMLURL, p.Title, p.State = n, "https://github.com/dspv/caprock/pull/"+strconv.Itoa(n), "t", state
	p.Head.Ref, p.Head.SHA, p.Base.Ref = ref, "sha"+strconv.Itoa(n), "master"
	if merged {
		at := "2026-10-01T00:00:00Z"
		p.MergedAt = &at
	}
	if headRepo != "" {
		p.Head.Repo = &struct {
			FullName string `json:"full_name"`
		}{FullName: headRepo}
	}
	return p
}

// A branch's PR is its open one, else the newest; a fork's same-named branch
// is not this repository's.
func TestPickBranchPRs(t *testing.T) {
	repo := Repo{Owner: "dspv", Name: "caprock"}
	m := pickBranchPRs(repo, []apiPull{
		branchPull(9, "feat/a", "closed", true, "dspv/caprock"), // newest, merged
		branchPull(8, "feat/a", "open", false, "dspv/caprock"),  // older, open: wins
		branchPull(7, "feat/b", "closed", true, "DSPV/Caprock"),
		branchPull(6, "feat/b", "closed", false, "dspv/caprock"), // older: loses
		branchPull(5, "main", "open", false, "someone/caprock"),  // a fork
		branchPull(4, "", "open", false, ""),
	})
	if len(m) != 2 {
		t.Fatalf("%+v", m)
	}
	if a := m["feat/a"]; a.Number != 8 || a.State != "open" || a.HeadSHA != "sha8" || a.Base != "master" {
		t.Fatalf("feat/a = %+v", a)
	}
	if b := m["feat/b"]; b.Number != 7 || b.State != "merged" {
		t.Fatalf("feat/b = %+v", b)
	}
}

// One list answers every branch, kept branchPullsKept; nothing is sent while
// GitHub is not connected.
func TestPullsByBranchIsOneKeptList(t *testing.T) {
	x := newFixture(t)
	repo := Repo{Owner: "dspv", Name: "caprock"}
	if _, e := x.s.PullsByBranch(context.Background(), repo); e == nil || e.Kind != KindNotConnected {
		t.Fatalf("not connected: %v", e)
	}
	if n := len(x.f.requests()); n != 0 {
		t.Fatalf("%d requests while not connected", n)
	}
	x.connect(t)
	x.f.failWith("GET /repos/dspv/caprock/pulls", func(w http.ResponseWriter, r *http.Request) {
		if q := r.URL.Query(); q.Get("state") != "all" || q.Get("sort") != "updated" || q.Get("per_page") != "50" {
			t.Errorf("query %q", r.URL.RawQuery)
		}
		answer(w, r, 200, []any{
			map[string]any{"number": 3, "html_url": "https://github.com/dspv/caprock/pull/3", "title": "x", "state": "open",
				"head": map[string]any{"ref": "feat/x", "sha": "abc", "repo": map[string]any{"full_name": "dspv/caprock"}}, "base": map[string]any{"ref": "master"}},
		})
	})
	m, e := x.s.PullsByBranch(context.Background(), repo)
	if e != nil || m["feat/x"].Number != 3 {
		t.Fatalf("%+v %v", m, e)
	}
	before := len(x.f.requests())
	x.advance(branchPullsKept - time.Second)
	if _, _ = x.s.PullsByBranch(context.Background(), repo); len(x.f.requests()) != before {
		t.Fatal("asked again within branchPullsKept")
	}
}

// A list GitHub refuses after a good one: the good one comes back, and
// RepoPullsRead says when it was read and why the newer read failed, until
// a read succeeds again (the board froze silently on 2026-10-14).
func TestPullsByBranchSaysAFailedRead(t *testing.T) {
	x := newFixture(t)
	repo := Repo{Owner: "dspv", Name: "caprock"}
	x.connect(t)
	ok := func(w http.ResponseWriter, r *http.Request) {
		answer(w, r, 200, []any{
			map[string]any{"number": 3, "html_url": "https://github.com/dspv/caprock/pull/3", "title": "x", "state": "open",
				"head": map[string]any{"ref": "feat/x", "sha": "abc"}, "base": map[string]any{"ref": "master"}},
		})
	}
	x.f.failWith("GET /repos/dspv/caprock/pulls", ok)
	if _, e := x.s.PullsByBranch(context.Background(), repo); e != nil {
		t.Fatal(e)
	}
	readAt := x.s.Now().UnixMilli()
	if at, failed := x.s.RepoPullsRead(repo); at != readAt || failed != nil {
		t.Fatalf("read: %d %v", at, failed)
	}
	x.f.failWith("GET /repos/dspv/caprock/pulls", func(w http.ResponseWriter, r *http.Request) {
		answer(w, r, 502, map[string]any{"message": "Server Error"})
	})
	x.advance(branchPullsKept + time.Second)
	m, e := x.s.PullsByBranch(context.Background(), repo)
	if e != nil || m["feat/x"].Number != 3 {
		t.Fatalf("the last list should come back: %+v %v", m, e)
	}
	if at, failed := x.s.RepoPullsRead(repo); at != readAt || failed == nil {
		t.Fatalf("after a refused read: %d %v", at, failed)
	}
	x.f.failWith("GET /repos/dspv/caprock/pulls", ok)
	x.advance(time.Second)
	if _, e := x.s.PullsByBranch(context.Background(), repo); e != nil {
		t.Fatal(e)
	}
	if at, failed := x.s.RepoPullsRead(repo); at != x.s.Now().UnixMilli() || failed != nil {
		t.Fatalf("read again: %d %v", at, failed)
	}
}

// A pull request's labels come with it, in GitHub's order, at most maxLabels.
func TestOwnPullsCarryLabels(t *testing.T) {
	p := branchPull(4, "feat/x", "open", false, "")
	for _, n := range []string{"bug", "ui", "", "a", "b", "c", "d", "e"} {
		p.Labels = append(p.Labels, struct {
			Name  string `json:"name"`
			Color string `json:"color"`
		}{Name: n, Color: "d73a4a"})
	}
	got := ownPulls(Repo{Owner: "dspv", Name: "caprock"}, []apiPull{p})[0].pr.Labels
	if len(got) != maxLabels || got[0].Name != "bug" || got[0].Color != "d73a4a" || got[2].Name != "a" {
		t.Fatalf("labels: %+v", got)
	}
}

// A branch is newly merged once: on the first list that shows it merged.
func TestNewlyMerged(t *testing.T) {
	before := map[string]BranchPR{"a": {State: "open"}, "b": {State: "merged"}}
	now := map[string]BranchPR{"a": {State: "merged"}, "b": {State: "merged"}, "c": {State: "merged"}, "d": {State: "open"}}
	if got := newlyMerged(before, now); len(got) != 2 || got[0] != "a" || got[1] != "c" {
		t.Fatalf("got %v", got)
	}
	if got := newlyMerged(now, now); len(got) != 0 {
		t.Fatalf("again: %v", got)
	}
}
