package github

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestMedianOf(t *testing.T) {
	if m := medianOf([]int64{30, 10, 20}); m == nil || m.MedianMS != 20 || m.Runs != 3 {
		t.Fatalf("odd: %+v", m)
	}
	if m := medianOf([]int64{10, 40, 20, 30}); m == nil || m.MedianMS != 25 || m.Runs != 4 {
		t.Fatalf("even: %+v", m)
	}
	// Fewer than two samples is no baseline, never a guessed one.
	if m := medianOf([]int64{10}); m != nil {
		t.Fatalf("one sample made a baseline: %+v", m)
	}
	if m := medianOf(nil); m != nil {
		t.Fatalf("no sample made a baseline: %+v", m)
	}
}

// A run and each of its jobs get the median of the workflow's last
// successful runs, the jobs matched by name; a job seen in fewer than two of
// them gets none. A finished past run's jobs are read once, and the list of
// past runs once per baselineListKept.
func TestWithBaselines(t *testing.T) {
	x := newFixture(t)
	repo := Repo{Owner: "ada", Name: "caprock"}
	cur := []CIRun{{ID: 40, WorkflowID: 1, Name: "CI", Status: "in_progress", Jobs: []CIJob{{ID: 401, Name: "test"}, {ID: 402, Name: "lint"}, {ID: 403, Name: "new job"}}}}
	if got := x.s.WithBaselines(context.Background(), repo, cur); got[0].Baseline != nil || len(x.f.requests()) != 0 {
		t.Fatalf("asked GitHub while not connected: %+v, %v", got[0], x.f.requests())
	}
	x.connect(t)
	start := len(x.f.requests())
	x.f.failWith("GET /repos/ada/caprock/actions/workflows/1/runs", func(w http.ResponseWriter, r *http.Request) {
		answer(w, r, 200, map[string]any{"workflow_runs": []any{
			wfRun(40, 1, "CI", "pull_request", "feat/x", "completed", "success", "2026-10-06T11:00:00Z", "2026-10-06T11:09:00Z"), // the run shown: left out
			wfRun(33, 1, "CI", "pull_request", "feat/a", "completed", "success", "2026-10-05T10:00:00Z", "2026-10-05T10:10:00Z"),
			wfRun(32, 1, "CI", "push", "main", "completed", "success", "2026-10-04T10:00:00Z", "2026-10-04T10:08:00Z"),
			wfRun(31, 1, "CI", "push", "main", "completed", "success", "2026-10-03T10:00:00Z", "2026-10-03T10:12:00Z"),
		}})
	})
	for id, mins := range map[int64][2]int{33: {5, 1}, 32: {4, 2}, 31: {6, 0}} {
		test, lint := mins[0], mins[1]
		x.f.failWith(fmt.Sprintf("GET /repos/ada/caprock/actions/runs/%d/jobs", id), func(w http.ResponseWriter, r *http.Request) {
			jobs := []any{map[string]any{"id": id*10 + 1, "run_id": id, "name": "test", "status": "completed", "conclusion": "success",
				"started_at": "2026-10-05T10:00:00Z", "completed_at": fmt.Sprintf("2026-10-05T10:%02d:00Z", test), "labels": []any{}, "steps": []any{}}}
			if lint > 0 {
				jobs = append(jobs, map[string]any{"id": id*10 + 2, "run_id": id, "name": "lint", "status": "completed", "conclusion": "success",
					"started_at": "2026-10-05T10:00:00Z", "completed_at": fmt.Sprintf("2026-10-05T10:%02d:00Z", lint), "labels": []any{}, "steps": []any{}})
			}
			answer(w, r, 200, map[string]any{"jobs": jobs})
		})
	}
	got := x.s.WithBaselines(context.Background(), repo, cur)
	if b := got[0].Baseline; b == nil || b.Runs != 3 || b.MedianMS != 10*60_000 {
		t.Fatalf("run baseline %+v", b)
	}
	if b := got[0].Jobs[0].Baseline; b == nil || b.Runs != 3 || b.MedianMS != 5*60_000 {
		t.Fatalf("test baseline %+v", b)
	}
	if b := got[0].Jobs[1].Baseline; b == nil || b.Runs != 2 || b.MedianMS != 90_000 {
		t.Fatalf("lint baseline %+v", b)
	}
	if got[0].Jobs[2].Baseline != nil {
		t.Fatalf("a job never seen before has a baseline: %+v", got[0].Jobs[2].Baseline)
	}
	if cur[0].Baseline != nil || cur[0].Jobs[0].Baseline != nil {
		t.Fatal("the runs given were changed")
	}
	reads := x.f.requests()[start:]
	if n := count(reads, "/actions/workflows/1/runs"); n != 1 {
		t.Fatalf("past runs listed %d times: %v", n, reads)
	}
	if n := count(reads, "/jobs"); n != 3 || count(reads, "/runs/40/jobs") != 0 {
		t.Fatalf("jobs read: %v", reads)
	}
	// Asked again, even after the list is read anew: the finished runs' jobs
	// are not read again.
	x.advance(baselineListKept + time.Minute)
	mark := len(x.f.requests())
	x.s.WithBaselines(context.Background(), repo, cur)
	again := x.f.requests()[mark:]
	if count(again, "/jobs") != 0 || count(again, "/actions/workflows/1/runs") != 1 {
		t.Fatalf("second ask read %v", again)
	}
}

func count(reqs []string, part string) int {
	n := 0
	for _, r := range reqs {
		if strings.Contains(r, part) {
			n++
		}
	}
	return n
}

// A run GitHub lists no jobs for yet goes out as `"jobs": []`. It went out as
// null, and the app's deck, reading it as a list, drew a black window on
// every launch while that release run was the newest.
func TestWithBaselinesKeepsAnEmptyJobListAList(t *testing.T) {
	x := newFixture(t)
	x.connect(t)
	x.f.failWith("GET /repos/ada/caprock/actions/workflows/7/runs", func(w http.ResponseWriter, r *http.Request) {
		answer(w, r, 200, map[string]any{"workflow_runs": []any{}})
	})
	got := x.s.WithBaselines(context.Background(), Repo{Owner: "ada", Name: "caprock"}, []CIRun{{ID: 70, WorkflowID: 7, Name: "Release", Status: "completed", Jobs: []CIJob{}}})
	b, err := json.Marshal(got[0])
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), `"jobs":[]`) {
		t.Fatalf("jobs not an empty list: %s", b)
	}
}
