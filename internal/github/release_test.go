package github

import (
	"context"
	"net/http"
	"sync/atomic"
	"testing"
	"time"
)

// wfRun is a workflow run with the fields the release and main views read.
func wfRun(id, workflow int64, name, event, branch, status, conclusion, started, updated string) map[string]any {
	return map[string]any{"id": id, "workflow_id": workflow, "name": name, "event": event, "head_branch": branch, "head_sha": "sha" + branch,
		"status": status, "conclusion": conclusion, "run_attempt": 1, "html_url": "https://github.com/ada/caprock/actions/runs/1",
		"created_at": started, "run_started_at": started, "updated_at": updated}
}

// A check run's link names its Actions job, which the deck's mini pipeline
// opens in the CI cell; any other check names none.
func TestJobOf(t *testing.T) {
	for link, want := range map[string]int64{
		"https://github.com/ada/caprock/actions/runs/7/job/71": 71,
		"https://github.com/ada/caprock/runs/71":               0,
		"https://ci.example/build/3":                           0,
		"":                                                     0,
	} {
		if got := jobOf(link); got != want {
			t.Errorf("%q: %d, want %d", link, got, want)
		}
	}
}

func TestIsReleaseRun(t *testing.T) {
	for _, c := range []struct {
		event, branch string
		want          bool
	}{
		{"push", "v1.2.3", true}, {"push", "1.2", true}, {"push", "v0.109.1", true}, {"push", "v1.2.3-rc.1", true},
		{"push", "app/v1.2.0", true}, {"push", "release-1.4", true}, {"push", "2026.10.1", true},
		{"release", "v1.0.0", true}, {"release", "", true},
		{"push", "main", false}, {"push", "feat/x", false}, {"push", "v1", false}, {"pull_request", "v1.2.3", false},
		{"push", "", false}, {"workflow_dispatch", "v1.2.3", false},
	} {
		if got := IsReleaseRun(c.event, c.branch, "main"); got != c.want {
			t.Errorf("%s %q: %v, want %v", c.event, c.branch, got, c.want)
		}
	}
	if IsReleaseRun("push", "1.2", "1.2") {
		t.Error("the default branch is never a tag")
	}
}

// The estimate is the median of the last successful release runs' spans, the
// running one and other events left out; too few runs is no estimate.
func TestMedianSpan(t *testing.T) {
	runs := []apiRun{
		{ID: 1, Event: "push", HeadBranch: "v1.3.0", Status: "in_progress", RunStartedAt: "2026-10-11T10:00:00Z", UpdatedAt: "2026-10-11T10:30:00Z"},
		{ID: 2, Event: "push", HeadBranch: "v1.2.0", Status: "completed", Conclusion: "success", RunStartedAt: "2026-10-10T10:00:00Z", UpdatedAt: "2026-10-10T10:10:00Z"},
		{ID: 3, Event: "workflow_dispatch", HeadBranch: "main", Status: "completed", Conclusion: "success", RunStartedAt: "2026-10-09T10:00:00Z", UpdatedAt: "2026-10-09T11:00:00Z"},
		{ID: 4, Event: "push", HeadBranch: "v1.1.0", Status: "completed", Conclusion: "success", RunStartedAt: "2026-10-08T10:00:00Z", UpdatedAt: "2026-10-08T10:20:00Z"},
		{ID: 5, Event: "release", HeadBranch: "v1.0.0", Status: "completed", Conclusion: "success", RunStartedAt: "2026-10-07T10:00:00Z", UpdatedAt: "2026-10-07T10:12:00Z"},
		{ID: 6, Event: "push", HeadBranch: "v0.9.0", Status: "completed", Conclusion: "failure", RunStartedAt: "2026-10-06T10:00:00Z", UpdatedAt: "2026-10-06T10:01:00Z"},
	}
	est := medianSpan(runs, 1, "main")
	if est == nil || est.Runs != 3 || est.MedianMS != 12*60_000 {
		t.Fatalf("odd: %+v", est)
	}
	if est := medianSpan(runs[:4], 1, "main"); est == nil || est.Runs != 2 || est.MedianMS != 15*60_000 {
		t.Fatalf("even: %+v", est)
	}
	if est := medianSpan(runs[:3], 1, "main"); est != nil {
		t.Fatalf("one past run made an estimate: %+v", est)
	}
}

// The newest tag push is the release run, read with its jobs; while it runs
// the estimate comes from the workflow's past successful runs; once it
// passed, the release page published for its tag.
func TestReleaseByRepo(t *testing.T) {
	x := newFixture(t)
	repo := Repo{Owner: "ada", Name: "caprock"}
	if _, e := x.s.ReleaseByRepo(context.Background(), repo, "main"); e == nil || e.Kind != KindNotConnected {
		t.Fatalf("want not connected, got %v", e)
	}
	if n := len(x.f.requests()); n != 0 {
		t.Fatalf("%d requests while not connected", n)
	}
	x.connect(t)
	var done atomic.Bool
	x.f.failWith("GET /repos/ada/caprock/actions/runs", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("event") == "release" {
			answer(w, r, 200, map[string]any{"workflow_runs": []any{}})
			return
		}
		cur := wfRun(30, 9, "Release", "push", "v1.2.0", "in_progress", "", "2026-10-06T11:55:00Z", "2026-10-06T11:58:00Z")
		if done.Load() {
			cur = wfRun(30, 9, "Release", "push", "v1.2.0", "completed", "success", "2026-10-06T11:55:00Z", "2026-10-06T12:07:00Z")
		}
		answer(w, r, 200, map[string]any{"workflow_runs": []any{
			wfRun(31, 1, "CI", "push", "main", "completed", "success", "2026-10-06T11:56:00Z", "2026-10-06T11:59:00Z"),
			cur,
			wfRun(20, 9, "Release", "push", "v1.1.0", "completed", "success", "2026-10-05T10:00:00Z", "2026-10-05T10:10:00Z"),
		}})
	})
	x.f.failWith("GET /repos/ada/caprock/actions/runs/30/jobs", func(w http.ResponseWriter, r *http.Request) {
		st, concl, end := "in_progress", "", ""
		if done.Load() {
			st, concl, end = "completed", "success", "2026-10-06T12:07:00Z"
		}
		answer(w, r, 200, map[string]any{"jobs": []any{map[string]any{"id": 301, "run_id": 30, "name": "goreleaser", "status": st, "conclusion": concl,
			"started_at": "2026-10-06T11:55:10Z", "completed_at": end, "labels": []any{"ubuntu-latest"},
			"steps": []any{step(1, "Build", st, concl, "2026-10-06T11:55:10Z", end)}}}})
	})
	x.f.failWith("GET /repos/ada/caprock/actions/workflows/9/runs", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("status") != "success" {
			t.Errorf("past runs asked without status=success: %s", r.URL.RawQuery)
		}
		answer(w, r, 200, map[string]any{"workflow_runs": []any{
			wfRun(20, 9, "Release", "push", "v1.1.0", "completed", "success", "2026-10-05T10:00:00Z", "2026-10-05T10:10:00Z"),
			wfRun(19, 9, "Release", "push", "v1.0.0", "completed", "success", "2026-10-04T10:00:00Z", "2026-10-04T10:20:00Z"),
			wfRun(18, 9, "Release", "workflow_dispatch", "main", "completed", "success", "2026-10-03T10:00:00Z", "2026-10-03T12:00:00Z"),
			wfRun(17, 9, "Release", "push", "v0.9.0", "completed", "success", "2026-10-02T10:00:00Z", "2026-10-02T10:14:00Z"),
		}})
	})
	x.f.failWith("GET /repos/ada/caprock/releases/tags/v1.2.0", func(w http.ResponseWriter, r *http.Request) {
		answer(w, r, 200, map[string]any{"html_url": "https://github.com/ada/caprock/releases/tag/v1.2.0", "published_at": "2026-10-06T12:06:30Z"})
	})
	rel, e := x.s.ReleaseByRepo(context.Background(), repo, "main")
	if e != nil {
		t.Fatal(e)
	}
	if rel.Tag != "v1.2.0" || rel.State != "running" || rel.Run == nil || rel.Run.ID != 30 || len(rel.Run.Jobs) != 1 || rel.Run.StartedAt == 0 {
		t.Fatalf("%+v", rel)
	}
	if rel.Estimate == nil || rel.Estimate.Runs != 3 || rel.Estimate.MedianMS != 14*60_000 || rel.Release != nil {
		t.Fatalf("estimate %+v release %+v", rel.Estimate, rel.Release)
	}
	before := len(x.f.requests())
	x.advance(5 * time.Second)
	if _, _ = x.s.ReleaseByRepo(context.Background(), repo, "main"); len(x.f.requests()) != before {
		t.Fatalf("asked again within %s", ciRunning)
	}
	done.Store(true)
	x.advance(ciRunning)
	rel, _ = x.s.ReleaseByRepo(context.Background(), repo, "main")
	if rel.State != "pass" || rel.Estimate != nil || rel.Release == nil || rel.Release.URL != "https://github.com/ada/caprock/releases/tag/v1.2.0" || rel.Release.PublishedAt == 0 {
		t.Fatalf("settled %+v %+v", rel, rel.Release)
	}
}

// A repository with no tag push or release among its recent runs has no
// release run; a 404 for a tag's release is "none", not an error.
func TestReleaseNoRuns(t *testing.T) {
	x := newFixture(t)
	x.connect(t)
	x.f.failWith("GET /repos/ada/caprock/actions/runs", func(w http.ResponseWriter, r *http.Request) {
		answer(w, r, 200, map[string]any{"workflow_runs": []any{wfRun(31, 1, "CI", "push", "main", "completed", "success", "2026-10-06T11:56:00Z", "2026-10-06T11:59:00Z")}})
	})
	rel, e := x.s.ReleaseByRepo(context.Background(), Repo{Owner: "ada", Name: "caprock"}, "main")
	if e != nil || rel.State != "none" || rel.Run != nil || rel.Tag != "" {
		t.Fatalf("%+v %v", rel, e)
	}
	if l := x.s.releaseLink(context.Background(), Repo{Owner: "ada", Name: "caprock"}, "v9.9.9"); l != nil {
		t.Fatalf("a missing release read as %+v", l)
	}
	if h := x.s.Status().Health; h.Error != nil {
		t.Fatalf("a 404 for a release marked the health line: %+v", h.Error)
	}
}

// The default branch's CI is the newest run of each workflow on it.
func TestMainCI(t *testing.T) {
	x := newFixture(t)
	repo := Repo{Owner: "ada", Name: "caprock"}
	if _, e := x.s.MainCI(context.Background(), repo, "main"); e == nil || e.Kind != KindNotConnected {
		t.Fatalf("want not connected, got %v", e)
	}
	x.connect(t)
	x.f.failWith("GET /repos/ada/caprock/actions/runs", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("branch") != "main" {
			t.Errorf("branch %q", r.URL.RawQuery)
		}
		answer(w, r, 200, map[string]any{"workflow_runs": []any{
			wfRun(50, 1, "CI", "push", "main", "completed", "failure", "2026-10-06T11:50:00Z", "2026-10-06T11:59:00Z"),
			wfRun(49, 1, "CI", "push", "main", "completed", "success", "2026-10-06T10:50:00Z", "2026-10-06T10:59:00Z"),
			wfRun(48, 3, "Docs", "push", "main", "completed", "success", "2026-10-06T10:40:00Z", "2026-10-06T10:41:00Z"),
		}})
	})
	for _, id := range []string{"50", "48"} {
		x.f.failWith("GET /repos/ada/caprock/actions/runs/"+id+"/jobs", func(w http.ResponseWriter, r *http.Request) {
			answer(w, r, 200, map[string]any{"jobs": []any{}})
		})
	}
	ci, e := x.s.MainCI(context.Background(), repo, "main")
	if e != nil {
		t.Fatal(e)
	}
	if ci.Branch != "main" || ci.State != "fail" || len(ci.Runs) != 2 || ci.Runs[0].ID != 50 || ci.Runs[1].ID != 48 || ci.HeadSHA != "shamain" {
		t.Fatalf("%+v", ci)
	}
	if _, e := x.s.MainCI(context.Background(), repo, ""); e == nil {
		t.Fatal("no branch read")
	}
}
