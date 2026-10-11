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
