package github

import (
	"context"
	"net/http"
	"testing"
	"time"
)

// A run is stuck past twice its workflow's median and ten minutes over it,
// or queued for a runner past StuckQueued; a slow two-minute workflow is not.
func TestStuckRuns(t *testing.T) {
	now := time.Date(2026, 10, 14, 12, 0, 0, 0, time.UTC)
	ago := func(m int) int64 { return now.Add(-time.Duration(m) * time.Minute).UnixMilli() }
	ok := func(name string, startAgo, took int) CIRun {
		return CIRun{Name: name, Status: "completed", Conclusion: "success", StartedAt: ago(startAgo), CreatedAt: ago(startAgo), UpdatedAt: ago(startAgo - took)}
	}
	runs := []CIRun{
		ok("ci", 300, 10), ok("ci", 200, 10), ok("lint", 300, 2), ok("lint", 200, 2),
		{ID: 1, Name: "ci", Status: "in_progress", StartedAt: ago(35), HeadBranch: "feat/a"}, // 35 > 20 and > 20: stuck
		{ID: 2, Name: "ci", Status: "in_progress", StartedAt: ago(15)},                       // under twice the median
		{ID: 3, Name: "lint", Status: "in_progress", StartedAt: ago(8)},                      // 4x, but under 10 minutes over
		{ID: 4, Name: "deploy", Status: "in_progress", StartedAt: ago(90)},                   // no median: never
		{ID: 5, Name: "ci", Status: "queued", CreatedAt: ago(20)},                            // queued too long
		{ID: 6, Name: "ci", Status: "queued", CreatedAt: ago(5)},
	}
	got := StuckRuns(runs, now, 14)
	if len(got) != 2 || got[0].ID != 1 || got[1].ID != 5 || got[0].MedianMS != 10*60_000 || got[0].Branch != "feat/a" {
		t.Fatalf("stuck = %+v", got)
	}
	if runsKeep(runs) != repoRunsActiveKept || runsKeep(runs[:4]) != repoRunsKept {
		t.Fatal("a list with a run going is kept as briefly as one should be")
	}
}

// The releases list leaves drafts and unpublished ones out, keeps GitHub's
// order, and sends nothing while GitHub is not connected.
func TestRepoReleases(t *testing.T) {
	x := newFixture(t)
	repo := Repo{Owner: "ada", Name: "caprock"}
	if _, e := x.s.RepoReleases(context.Background(), repo); e == nil || e.Kind != KindNotConnected {
		t.Fatalf("want not connected, got %v", e)
	}
	if n := len(x.f.requests()); n != 0 {
		t.Fatalf("%d requests while not connected", n)
	}
	x.connect(t)
	x.f.failWith("GET /repos/ada/caprock/releases", func(w http.ResponseWriter, r *http.Request) {
		answer(w, r, 200, []any{
			map[string]any{"tag_name": "v2", "name": "Two", "html_url": "https://github.com/ada/caprock/releases/tag/v2", "published_at": "2026-10-05T10:00:00Z"},
			map[string]any{"tag_name": "v3", "draft": true},
			map[string]any{"tag_name": "v1", "name": "v1", "published_at": "2026-10-01T10:00:00Z", "prerelease": true},
		})
	})
	got, e := x.s.RepoReleases(context.Background(), repo)
	if e != nil || len(got) != 2 || got[0].Tag != "v2" || got[0].Name != "Two" || got[1].Name != "" || !got[1].Prerelease || got[0].PublishedAt == 0 {
		t.Fatalf("releases = %+v, %v", got, e)
	}
	n := len(x.f.requests())
	if _, e := x.s.RepoReleases(context.Background(), repo); e != nil || len(x.f.requests()) != n {
		t.Fatal("a kept list was asked again")
	}
	if c, ok := x.s.CachedRepoReleases(repo); !ok || len(c) != 2 {
		t.Fatalf("cached = %+v", c)
	}
}

// The status page is not asked while GitHub is not connected.
func TestStatusPageNeedsConnection(t *testing.T) {
	x := newFixture(t)
	x.s.StatusURL = x.f.srv.URL + "/status"
	if _, ok := x.s.StatusPage(context.Background()); ok {
		t.Fatal("status read while not connected")
	}
	if n := len(x.f.requests()); n != 0 {
		t.Fatalf("%d requests while not connected", n)
	}
	got, err := parseStatus([]byte(`{"status":{"indicator":"none","description":"All Systems Operational"},"components":[{"name":"Actions","status":"operational"},{"name":"Packages","status":"operational"},{"name":"Copilot","status":"partial_outage"}],"incidents":[]}`))
	if err != nil || got.Indicator != "none" || len(got.Components) != 2 || got.Components[1].Name != "Copilot" || len(got.Incidents) != 0 {
		t.Fatalf("parsed = %+v %v", got, err)
	}
}
