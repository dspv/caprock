package github

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"
)

// The job GitHub never ran, as its API answered for run 44324234291 (job
// 134871157816, 2026-11-18): cancelled after ~15 minutes, no step, no runner.
func idleJob(id, run int64, conclusion string) map[string]any {
	return map[string]any{"id": id, "run_id": run, "name": "go (macos-latest)", "status": "completed", "conclusion": conclusion,
		"started_at": "2026-11-18T14:26:25Z", "completed_at": "2026-11-18T14:41:27Z", "labels": []any{"macos-latest"},
		"runner_id": 0, "runner_name": "", "runner_group_id": 0, "runner_group_name": "", "steps": []any{}}
}

// A job that ran: a runner, and steps.
func ranJob(id, run int64, conclusion string) map[string]any {
	return map[string]any{"id": id, "run_id": run, "name": "go (ubuntu-latest)", "status": "completed", "conclusion": conclusion,
		"started_at": "2026-11-18T14:26:25Z", "completed_at": "2026-11-18T14:30:00Z", "labels": []any{"ubuntu-latest"},
		"runner_id": 12, "runner_name": "GitHub Actions 12", "runner_group_name": "GitHub Actions",
		"steps": []any{step(1, "Set up job", "completed", "success", "2026-11-18T14:26:30Z", "2026-11-18T14:26:35Z"),
			step(2, "go test", "completed", conclusion, "2026-11-18T14:26:35Z", "2026-11-18T14:30:00Z")}}
}

func TestNoRunnerRule(t *testing.T) {
	for _, c := range []struct {
		conclusion string
		steps, id  int
		name       string
		want       bool
	}{
		{"cancelled", 0, 0, "", true},
		{"failure", 0, 0, "", true},
		{"failure", 3, 0, "", false},                   // it ran steps
		{"cancelled", 0, 7, "", false},                 // a runner took it
		{"cancelled", 0, 0, "GitHub Actions 7", false}, // a runner took it
		{"success", 0, 0, "", false},                   // nothing to tell apart
		{"skipped", 0, 0, "", false},                   // skipped by a condition
		{"timed_out", 0, 0, "", false},                 // not the queue's give-up
		{"startup_failure", 0, 0, "", false},           // the workflow file, not a machine
		{"action_required", 0, 0, "", false},           // waits for a person
		{"neutral", 0, 0, "", false},                   // passes
		{"stale", 0, 0, "", false},                     // superseded
		{"", 0, 0, "", false},                          // not finished
		{"cancelled", 0, 0, "self-hosted-mini", false}, // a self-hosted runner took it
	} {
		if got := noRunner(c.conclusion, c.steps, c.id, c.name); got != c.want {
			t.Errorf("noRunner(%q, %d steps, runner %d %q) = %v, want %v", c.conclusion, c.steps, c.id, c.name, got, c.want)
		}
	}
}

// A run whose only non-passing job never got a machine is not failed: the
// commit's CI says no_runner, the job carries no_runner, and a run with a
// real failure beside it stays fail.
func TestCINoRunnerState(t *testing.T) {
	x := newFixture(t)
	x.connect(t)
	repo := Repo{Owner: "ada", Name: "caprock"}
	runsWith(x, []map[string]any{actionsRun(7, "completed", "failure", "2026-11-18T14:41:30Z")},
		map[string][]any{"7": {ranJob(70, 7, "success"), idleJob(71, 7, "cancelled")}})
	ci, e := x.s.CIBySHA(context.Background(), repo, "sha1")
	if e != nil {
		t.Fatal(e)
	}
	if ci.State != "no_runner" {
		t.Fatalf("state %q, want no_runner", ci.State)
	}
	if j := ci.Runs[0].Jobs; j[0].NoRunner || !j[1].NoRunner {
		t.Fatalf("jobs: %+v", j)
	}

	y := newFixture(t)
	y.connect(t)
	runsWith(y, []map[string]any{actionsRun(7, "completed", "failure", "2026-11-18T14:41:30Z")},
		map[string][]any{"7": {ranJob(70, 7, "failure"), idleJob(71, 7, "cancelled")}})
	ci, e = y.s.CIBySHA(context.Background(), repo, "sha1")
	if e != nil {
		t.Fatal(e)
	}
	if ci.State != "fail" {
		t.Fatalf("a real failure beside it: state %q, want fail", ci.State)
	}
}

func checkRun(name, conclusion string, run, job int64) map[string]any {
	return map[string]any{"name": name, "status": "completed", "conclusion": conclusion,
		"html_url":   fmt.Sprintf("https://github.com/ada/caprock/actions/runs/%d/job/%d", run, job),
		"started_at": "2026-11-18T14:26:25Z", "completed_at": "2026-11-18T14:41:27Z"}
}

// A pull request's checks: the failed check whose job never got a machine
// is counted apart, the checks' state is no_runner rather than fail, one
// read of the run's jobs decides it, and a later read asks GitHub nothing
// more about that job. A passing check costs no jobs read.
func TestChecksNoRunner(t *testing.T) {
	x := newFixture(t)
	x.connect(t)
	repo := Repo{Owner: "ada", Name: "caprock"}
	x.f.runs["sha1"] = []map[string]any{checkRun("go (ubuntu-latest)", "success", 7, 70), checkRun("go (macos-latest)", "cancelled", 7, 71)}
	runsWith(x, nil, map[string][]any{"7": {ranJob(70, 7, "success"), idleJob(71, 7, "cancelled")}})
	got, _, e := x.s.readChecks(context.Background(), repo, "sha1")
	if e != nil {
		t.Fatal(e)
	}
	if got.State != "no_runner" || got.Failed != 0 || got.NoRunner != 1 || got.Passed != 1 {
		t.Fatalf("checks: %+v", got)
	}
	if !got.Items[1].NoRunner || got.Items[1].State != "fail" || got.Items[0].NoRunner {
		t.Fatalf("items: %+v", got.Items)
	}
	jobs := posts(x, "GET /repos/ada/caprock/actions/runs/7/jobs")
	if len(jobs) != 1 || !strings.Contains(jobs[0], "filter=all") {
		t.Fatalf("jobs reads: %v", jobs)
	}
	if _, _, e := x.s.readChecks(context.Background(), repo, "sha1"); e != nil {
		t.Fatal(e)
	}
	if n := len(posts(x, "GET /repos/ada/caprock/actions/runs/7/jobs")); n != 1 {
		t.Fatalf("the job's verdict was asked again: %d reads", n)
	}

	// A real failure beside it: fail, and only the real one counted failed.
	x.f.runs["sha2"] = []map[string]any{checkRun("go (ubuntu-latest)", "failure", 8, 80), checkRun("go (macos-latest)", "cancelled", 8, 81)}
	runsWith(x, nil, map[string][]any{"8": {ranJob(80, 8, "failure"), idleJob(81, 8, "cancelled")}})
	got, _, e = x.s.readChecks(context.Background(), repo, "sha2")
	if e != nil {
		t.Fatal(e)
	}
	if got.State != "fail" || got.Failed != 1 || got.NoRunner != 1 {
		t.Fatalf("mixed: %+v", got)
	}

	// All green: no jobs read at all.
	x.f.runs["sha3"] = []map[string]any{checkRun("go (ubuntu-latest)", "success", 9, 90)}
	if _, _, e := x.s.readChecks(context.Background(), repo, "sha3"); e != nil {
		t.Fatal(e)
	}
	if n := len(posts(x, "GET /repos/ada/caprock/actions/runs/9/jobs")); n != 0 {
		t.Fatalf("a green commit's jobs were read: %d", n)
	}
}

// When the jobs read fails, the check stays failed, as before this existed.
func TestChecksNoRunnerReadFails(t *testing.T) {
	x := newFixture(t)
	x.connect(t)
	repo := Repo{Owner: "ada", Name: "caprock"}
	x.f.runs["sha1"] = []map[string]any{checkRun("go (macos-latest)", "cancelled", 7, 71)}
	x.f.failWith("GET /repos/ada/caprock/actions/runs/7/jobs", func(w http.ResponseWriter, r *http.Request) {
		answer(w, r, 500, map[string]any{"message": "boom"})
	})
	got, _, e := x.s.readChecks(context.Background(), repo, "sha1")
	if e != nil {
		t.Fatal(e)
	}
	if got.State != "fail" || got.Failed != 1 || got.Items[0].NoRunner {
		t.Fatalf("checks: %+v", got)
	}
}

// Kept runs answer without a read: CIBySHA's copy of the commit decides.
func TestChecksNoRunnerFromKeptRuns(t *testing.T) {
	x := newFixture(t)
	x.connect(t)
	repo := Repo{Owner: "ada", Name: "caprock"}
	runsWith(x, []map[string]any{actionsRun(7, "completed", "failure", "2026-11-18T14:41:30Z")},
		map[string][]any{"7": {idleJob(71, 7, "failure")}})
	if _, e := x.s.CIBySHA(context.Background(), repo, "sha1"); e != nil {
		t.Fatal(e)
	}
	before := len(posts(x, "GET /repos/ada/caprock/actions/runs/7/jobs"))
	x.f.runs["sha1"] = []map[string]any{checkRun("go (macos-latest)", "cancelled", 7, 71)}
	got, _, e := x.s.readChecks(context.Background(), repo, "sha1")
	if e != nil {
		t.Fatal(e)
	}
	if got.State != "no_runner" || !got.Items[0].NoRunner {
		t.Fatalf("checks: %+v", got)
	}
	if after := len(posts(x, "GET /repos/ada/caprock/actions/runs/7/jobs")); after != before {
		t.Fatalf("jobs read again: %d -> %d", before, after)
	}
}
