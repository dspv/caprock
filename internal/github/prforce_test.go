package github

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// runsWith answers a commit's runs and each run's jobs.
func runsWith(x *fixture, runs []map[string]any, jobs map[string][]any) {
	x.f.failWith("GET /repos/ada/caprock/actions/runs", func(w http.ResponseWriter, r *http.Request) {
		out := []any{}
		for _, run := range runs {
			out = append(out, run)
		}
		answer(w, r, 200, map[string]any{"total_count": len(out), "workflow_runs": out})
	})
	for id, js := range jobs {
		js := js
		x.f.failWith("GET /repos/ada/caprock/actions/runs/"+id+"/jobs", func(w http.ResponseWriter, r *http.Request) {
			answer(w, r, 200, map[string]any{"total_count": len(js), "jobs": js})
		})
	}
}

func forceJob(id, run int64, name, conclusion string) map[string]any {
	return map[string]any{"id": id, "run_id": run, "name": name, "status": "completed", "conclusion": conclusion,
		"started_at": "2026-10-11T10:00:00Z", "completed_at": "2026-10-11T10:02:00Z", "labels": []any{"ubuntu-latest"}, "steps": []any{}}
}

func posts(x *fixture, prefix string) []string {
	var out []string
	for _, r := range x.f.requests() {
		if strings.HasPrefix(r, prefix) {
			out = append(out, r)
		}
	}
	return out
}

// A failed run's failed jobs are re-run, and only those; a run that passed is
// left alone; the commit's kept runs are forgotten so the next read asks.
func TestRerunChecksFailedJobs(t *testing.T) {
	x := newFixture(t)
	repo := Repo{Owner: "ada", Name: "caprock"}
	if _, e := x.s.RerunChecks(context.Background(), repo, "sha1"); e == nil || e.Kind != KindNotConnected {
		t.Fatalf("want not connected, got %v", e)
	}
	x.connect(t)
	runsWith(x, []map[string]any{actionsRun(7, "completed", "failure", "2026-10-11T10:09:00Z"), actionsRun(8, "completed", "success", "2026-10-11T10:10:00Z")},
		map[string][]any{"7": {forceJob(70, 7, "lint", "success"), forceJob(71, 7, "test (windows)", "failure"), forceJob(72, 7, "test (linux)", "cancelled")}, "8": {forceJob(80, 8, "docs", "success")}})
	ok := 0
	x.f.failWith("POST /repos/ada/caprock/actions/runs/7/rerun-failed-jobs", func(w http.ResponseWriter, r *http.Request) {
		ok++
		w.WriteHeader(201)
	})
	got, e := x.s.RerunChecks(context.Background(), repo, "sha1")
	if e != nil {
		t.Fatal(e)
	}
	if got.Mode != "failed" || got.Runs != 1 || got.Jobs != 2 || ok != 1 {
		t.Fatalf("%+v, %d posts", got, ok)
	}
	if p := posts(x, "POST /repos/ada/caprock/actions/runs/8"); len(p) != 0 {
		t.Fatalf("the passing run was re-run: %v", p)
	}
	before := len(posts(x, "GET /repos/ada/caprock/actions/runs?"))
	if _, e := x.s.CIBySHA(context.Background(), repo, "sha1"); e != nil {
		t.Fatal(e)
	}
	if after := len(posts(x, "GET /repos/ada/caprock/actions/runs?")); after != before+1 {
		t.Fatalf("the runs were not asked again after the re-run: %d -> %d", before, after)
	}
}

// With nothing failed (a flaky green the user still wants checked), every
// finished run is re-run whole; a run still going is left alone.
func TestRerunChecksAllWhenNoneFailed(t *testing.T) {
	x := newFixture(t)
	x.connect(t)
	repo := Repo{Owner: "ada", Name: "caprock"}
	runsWith(x, []map[string]any{actionsRun(7, "completed", "success", "2026-10-11T10:09:00Z"), actionsRun(9, "in_progress", "", "2026-10-11T10:09:00Z")},
		map[string][]any{"7": {forceJob(70, 7, "lint", "success"), forceJob(71, 7, "test", "success")}, "9": {}})
	x.f.failWith("POST /repos/ada/caprock/actions/runs/7/rerun", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(201) })
	got, e := x.s.RerunChecks(context.Background(), repo, "sha1")
	if e != nil {
		t.Fatal(e)
	}
	if got.Mode != "all" || got.Runs != 1 || got.Jobs != 2 {
		t.Fatalf("%+v", got)
	}
	if p := posts(x, "POST /repos/ada/caprock/actions/runs/9"); len(p) != 0 {
		t.Fatalf("a running run was re-run: %v", p)
	}
	// Everything still going: nothing to re-run, said so.
	runsWith(x, []map[string]any{actionsRun(9, "in_progress", "", "2026-10-11T10:09:00Z")}, map[string][]any{"9": {}})
	if _, e := x.s.RerunChecks(context.Background(), repo, "sha1"); e == nil || e.Kind != KindState || !strings.Contains(e.Message, "still going") {
		t.Fatalf("all running: %v", e)
	}
}

// A token that may not write Actions gets the permission named, and the
// health line is not marked: a read-only token is not a broken connection.
func TestRerunChecksMissingPermission(t *testing.T) {
	x := newFixture(t)
	x.connect(t)
	repo := Repo{Owner: "ada", Name: "caprock"}
	runsWith(x, []map[string]any{actionsRun(7, "completed", "failure", "2026-10-11T10:09:00Z")}, map[string][]any{"7": {forceJob(71, 7, "test", "failure")}})
	x.f.failWith("POST /repos/ada/caprock/actions/runs/7/rerun-failed-jobs", func(w http.ResponseWriter, r *http.Request) {
		answer(w, r, 403, map[string]any{"message": "Resource not accessible by personal access token"})
	})
	_, e := x.s.RerunChecks(context.Background(), repo, "sha1")
	if e == nil || e.Kind != KindScope || len(e.Needs) == 0 || !strings.Contains(e.Needs[0], `"Actions" repository permission (write)`) {
		t.Fatalf("%+v", e)
	}
	if st := x.s.Status(); st.Health.Error != nil && strings.Contains(st.Health.Error.Doing, "Re-running") {
		t.Fatalf("the health line was marked: %+v", st.Health.Error)
	}
	// GitHub's own header wins over the documented fallback.
	x.f.failWith("POST /repos/ada/caprock/actions/runs/7/rerun-failed-jobs", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Accepted-GitHub-Permissions", "actions=write")
		answer(w, r, 403, map[string]any{"message": "Resource not accessible by personal access token"})
	})
	if _, e := x.s.RerunChecks(context.Background(), repo, "sha1"); e == nil || len(e.Needs) != 1 || e.Needs[0] != "actions=write" {
		t.Fatalf("header: %+v", e)
	}
}

// Update branch sends GitHub's update-branch with the head the deck read;
// a refusal names the permission; a moved head is said in words.
func TestUpdateBranch(t *testing.T) {
	x := newFixture(t)
	repo := Repo{Owner: "ada", Name: "caprock"}
	if e := x.s.UpdateBranch(context.Background(), repo, 12, "abc"); e == nil || e.Kind != KindNotConnected {
		t.Fatalf("want not connected, got %v", e)
	}
	x.connect(t)
	var body map[string]any
	x.f.failWith("PUT /repos/ada/caprock/pulls/12/update-branch", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&body)
		answer(w, r, 202, map[string]any{"message": "Updating pull request branch.", "url": "https://github.com/ada/caprock/pull/12"})
	})
	if e := x.s.UpdateBranch(context.Background(), repo, 12, "abc"); e != nil {
		t.Fatal(e)
	}
	if body["expected_head_sha"] != "abc" {
		t.Fatalf("body %v", body)
	}
	x.f.failWith("PUT /repos/ada/caprock/pulls/12/update-branch", func(w http.ResponseWriter, r *http.Request) {
		answer(w, r, 403, map[string]any{"message": "Resource not accessible by personal access token"})
	})
	if e := x.s.UpdateBranch(context.Background(), repo, 12, "abc"); e == nil || e.Kind != KindScope || !strings.Contains(e.Needs[0], `"Pull requests" repository permission (write)`) {
		t.Fatalf("permission: %+v", e)
	}
	x.f.failWith("PUT /repos/ada/caprock/pulls/12/update-branch", func(w http.ResponseWriter, r *http.Request) {
		answer(w, r, 422, map[string]any{"message": "expected head sha didn’t match current head ref."})
	})
	if e := x.s.UpdateBranch(context.Background(), repo, 12, "abc"); e == nil || !strings.Contains(e.Message, "moved since") {
		t.Fatalf("moved: %+v", e)
	}
	if e := x.s.UpdateBranch(context.Background(), Repo{Owner: "../x", Name: "y"}, 12, ""); e == nil || e.Kind != KindInvalid {
		t.Fatalf("bad repo: %v", e)
	}
}
