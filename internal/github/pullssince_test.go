package github

import (
	"context"
	"net/http"
	"strconv"
	"testing"
	"time"
)

// sincePulls is n pull requests updated an hour apart, newest first, from
// newest; every third merged, #2 from a fork.
func sincePulls(n int, newest time.Time) []any {
	out := make([]any, 0, n)
	for i := 0; i < n; i++ {
		num := n - i
		at := newest.Add(-time.Duration(i) * time.Hour).UTC().Format(time.RFC3339)
		repo := "ada/caprock"
		if num == 2 {
			repo = "someone/caprock"
		}
		p := map[string]any{"number": num, "html_url": "https://github.com/ada/caprock/pull/" + strconv.Itoa(num), "title": "t",
			"state": "closed", "created_at": at, "updated_at": at,
			"head": map[string]any{"ref": "feat/" + strconv.Itoa(num), "sha": "s", "repo": map[string]any{"full_name": repo}},
			"base": map[string]any{"ref": "master"}}
		if num%3 == 0 {
			p["merged_at"] = at
		}
		out = append(out, p)
	}
	return out
}

// The read goes page by page until a page reaches past since, keeps a
// fork's pull request without its branch, and sends nothing unconnected.
func TestPullsSinceReadsPagesUntilThePeriodStart(t *testing.T) {
	x := newFixture(t)
	repo := Repo{Owner: "ada", Name: "caprock"}
	if _, _, e := x.s.PullsSince(context.Background(), repo, 0, 3); e == nil || e.Kind != KindNotConnected {
		t.Fatalf("not connected: %v", e)
	}
	x.connect(t)
	newest := time.Date(2026, 10, 25, 12, 0, 0, 0, time.UTC)
	all := sincePulls(250, newest)
	var pages []string
	x.f.failWith("GET /repos/ada/caprock/pulls", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if q.Get("state") != "all" || q.Get("sort") != "updated" || q.Get("direction") != "desc" || q.Get("per_page") != "100" {
			t.Errorf("query %q", r.URL.RawQuery)
		}
		pages = append(pages, q.Get("page"))
		p, _ := strconv.Atoi(q.Get("page"))
		lo, hi := (p-1)*100, p*100
		if hi > len(all) {
			hi = len(all)
		}
		if lo > hi {
			lo = hi
		}
		answer(w, r, 200, all[lo:hi])
	})
	// 150 hours back: two pages, the second reaching past since.
	since := newest.Add(-149 * time.Hour).UnixMilli()
	prs, complete, e := x.s.PullsSince(context.Background(), repo, since, 10)
	if e != nil || !complete || len(prs) != 150 {
		t.Fatalf("%d %v %v", len(prs), complete, e)
	}
	if len(pages) != 2 || pages[0] != "1" || pages[1] != "2" {
		t.Fatalf("pages %v", pages)
	}
	if prs[0].Number != 250 || prs[0].UpdatedAt != newest.UnixMilli() || prs[0].Head != "feat/250" {
		t.Fatalf("first %+v", prs[0])
	}
	if prs[1].State != "merged" || prs[1].MergedAt == 0 || prs[2].State != "closed" { // #249, #248
		t.Fatalf("%+v %+v", prs[1], prs[2])
	}

	// The cap: one page asked, not reaching since, is incomplete.
	pages = nil
	prs, complete, e = x.s.PullsSince(context.Background(), repo, 0, 1)
	if e != nil || complete || len(prs) != 100 || len(pages) != 1 {
		t.Fatalf("capped: %d %v %v %v", len(prs), complete, e, pages)
	}
	// A short last page ends the read: all 250, the fork's without a branch.
	pages = nil
	prs, complete, e = x.s.PullsSince(context.Background(), repo, 0, 0)
	if e != nil || !complete || len(prs) != 250 || len(pages) != 3 {
		t.Fatalf("whole: %d %v %v %v", len(prs), complete, e, pages)
	}
	if fork := prs[248]; fork.Number != 2 || fork.Head != "" {
		t.Fatalf("fork %+v", fork)
	}
}
