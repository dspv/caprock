package github

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// actionsRun is a workflow run as GitHub returns it.
func actionsRun(id int64, status, conclusion, updated string) map[string]any {
	return map[string]any{"id": id, "name": "CI", "event": "pull_request", "status": status, "conclusion": conclusion, "run_attempt": 1,
		"html_url": fmt.Sprintf("https://github.com/ada/caprock/actions/runs/%d", id), "created_at": "2026-10-11T10:00:00Z", "updated_at": updated}
}

func step(n int, name, status, conclusion, start, end string) map[string]any {
	return map[string]any{"number": n, "name": name, "status": status, "conclusion": conclusion, "started_at": start, "completed_at": end}
}

// A commit's runs are read with their jobs and steps, durations from
// GitHub's timestamps; the runner time sums the finished jobs per OS; and
// what was read is kept briefly while a job runs, longer once all settled.
func TestCIBySHAReadsJobsAndSteps(t *testing.T) {
	x := newFixture(t)
	repo := Repo{Owner: "ada", Name: "caprock"}
	if _, e := x.s.CIBySHA(context.Background(), repo, "sha1"); e == nil || e.Kind != KindNotConnected {
		t.Fatalf("want not connected, got %v", e)
	}
	if n := len(x.f.requests()); n != 0 {
		t.Fatalf("%d requests while not connected", n)
	}
	x.connect(t)
	var winStatus atomic.Value
	winStatus.Store("in_progress")
	x.f.failWith("GET /repos/ada/caprock/actions/runs", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("head_sha") != "sha1" {
			t.Errorf("head_sha %q", r.URL.RawQuery)
		}
		st := "in_progress"
		if winStatus.Load() == "completed" {
			st = "completed"
		}
		concl := ""
		if st == "completed" {
			concl = "failure"
		}
		answer(w, r, 200, map[string]any{"total_count": 1, "workflow_runs": []any{actionsRun(7, st, concl, "2026-10-11T10:09:00Z")}})
	})
	x.f.failWith("GET /repos/ada/caprock/actions/runs/7/jobs", func(w http.ResponseWriter, r *http.Request) {
		win := map[string]any{"id": 71, "run_id": 7, "name": "test (windows-latest)", "status": "in_progress", "started_at": "2026-10-11T10:01:00Z",
			"labels": []any{"windows-latest"}, "html_url": "https://github.com/ada/caprock/actions/runs/7/job/71",
			"steps": []any{step(1, "Set up job", "completed", "success", "2026-10-11T10:01:00Z", "2026-10-11T10:01:05Z"), step(2, "go test", "in_progress", "", "2026-10-11T10:01:05Z", "")}}
		if winStatus.Load() == "completed" {
			win["status"], win["conclusion"], win["completed_at"] = "completed", "failure", "2026-10-11T10:08:00Z"
			win["steps"] = []any{step(1, "Set up job", "completed", "success", "2026-10-11T10:01:00Z", "2026-10-11T10:01:05Z"), step(2, "go test", "completed", "failure", "2026-10-11T10:01:05Z", "2026-10-11T10:08:00Z")}
		}
		answer(w, r, 200, map[string]any{"total_count": 2, "jobs": []any{
			map[string]any{"id": 70, "run_id": 7, "name": "lint", "status": "completed", "conclusion": "success", "started_at": "2026-10-11T10:00:30Z", "completed_at": "2026-10-11T10:02:00Z",
				"labels": []any{"ubuntu-latest"}, "runner_name": "GitHub Actions 3", "steps": []any{step(1, "golangci-lint", "completed", "success", "2026-10-11T10:00:30Z", "2026-10-11T10:02:00Z")}},
			win,
		}})
	})
	ci, e := x.s.CIBySHA(context.Background(), repo, "sha1")
	if e != nil {
		t.Fatal(e)
	}
	if ci.State != "running" || len(ci.Runs) != 1 || len(ci.Runs[0].Jobs) != 2 {
		t.Fatalf("%+v", ci)
	}
	lint, win := ci.Runs[0].Jobs[0], ci.Runs[0].Jobs[1]
	if lint.DurationMS != 90_000 || lint.OS != "linux" || lint.Steps[0].DurationMS != 90_000 || lint.RunnerName != "GitHub Actions 3" {
		t.Fatalf("lint %+v", lint)
	}
	if win.DurationMS != 0 || win.OS != "windows" || win.Steps[0].DurationMS != 5_000 || win.Steps[1].Status != "in_progress" {
		t.Fatalf("windows %+v", win)
	}
	// Only finished jobs count; a running one's time is the reader's to tick.
	if ci.RunnerMS != 90_000 || len(ci.ByOS) != 1 || ci.ByOS[0].OS != "linux" {
		t.Fatalf("runner %d %+v", ci.RunnerMS, ci.ByOS)
	}
	before := len(x.f.requests())
	x.advance(5 * time.Second)
	if _, e := x.s.CIBySHA(context.Background(), repo, "sha1"); e != nil || len(x.f.requests()) != before {
		t.Fatalf("asked again within %s", ciRunning)
	}
	winStatus.Store("completed")
	x.advance(ciRunning)
	ci, _ = x.s.CIBySHA(context.Background(), repo, "sha1")
	if ci.State != "fail" || ci.RunnerMS != 90_000+420_000 || len(ci.ByOS) != 2 || ci.ByOS[0].OS != "windows" || ci.ByOS[0].MS != 420_000 {
		t.Fatalf("settled %+v", ci)
	}
	if st := ci.Runs[0].Jobs[1].Steps[1]; st.Conclusion != "failure" || st.DurationMS != 415_000 {
		t.Fatalf("failed step %+v", st)
	}
	// Settled: kept for ciSettled, and then a settled run with the same
	// update time keeps its jobs (one request, not two).
	before = len(x.f.requests())
	x.advance(time.Minute)
	if _, _ = x.s.CIBySHA(context.Background(), repo, "sha1"); len(x.f.requests()) != before {
		t.Fatal("a settled CI was asked again within a minute")
	}
	x.advance(ciSettled)
	_, _ = x.s.CIBySHA(context.Background(), repo, "sha1")
	if got := len(x.f.requests()) - before; got != 1 {
		t.Fatalf("%d requests to re-read a settled CI:\n%s", got, strings.Join(x.f.requests()[before:], "\n"))
	}
}

func TestRunnerOS(t *testing.T) {
	for want, labels := range map[string][]string{
		"linux": {"ubuntu-latest"}, "windows": {"windows-2022"}, "macos": {"macos-14"}, "self-hosted": {"self-hosted", "linux", "x64"}, "": {"big-box"},
	} {
		if got := runnerOS(labels); got != want {
			t.Errorf("%v: %q, want %q", labels, got, want)
		}
	}
}

// A failed job's log is found through GitHub's redirect, downloaded without
// the token, and cut to the lines around the last error.
func TestJobLogTailsTheError(t *testing.T) {
	x := newFixture(t)
	x.connect(t)
	repo := Repo{Owner: "ada", Name: "caprock"}
	var b strings.Builder
	for i := 0; i < 500; i++ {
		fmt.Fprintf(&b, "2026-10-11T10:01:%02d.1234567Z line %d\n", i%60, i)
	}
	b.WriteString("2026-10-11T10:07:59.0000000Z --- FAIL: TestDeck (0.01s)\n")
	b.WriteString("2026-10-11T10:08:00.0000000Z ##[error]Process completed with exit code 1.\n")
	for i := 0; i < 30; i++ {
		fmt.Fprintf(&b, "2026-10-11T10:08:01.0000000Z cleanup %d\n", i)
	}
	logBody := b.String()
	var auth atomic.Value
	auth.Store("")
	x.f.failWith("GET /repos/ada/caprock/actions/jobs/71/logs", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer ghp_good" {
			w.WriteHeader(401)
			return
		}
		w.Header().Set("Location", x.f.srv.URL+"/_logs/71?sig=abc")
		w.WriteHeader(http.StatusFound)
	})
	x.f.failWith("GET /_logs/71", func(w http.ResponseWriter, r *http.Request) {
		auth.Store(r.Header.Get("Authorization"))
		_, _ = w.Write([]byte(logBody))
	})
	got, e := x.s.JobLog(context.Background(), repo, 71)
	if e != nil {
		t.Fatal(e)
	}
	if a := auth.Load().(string); a != "" {
		t.Fatalf("the token went to the log storage: %q", a)
	}
	if got.ErrorLine < 0 || !strings.Contains(got.Lines[got.ErrorLine], "##[error]Process completed") {
		t.Fatalf("error line %d of %d", got.ErrorLine, len(got.Lines))
	}
	if got.ErrorLine != logBefore || len(got.Lines) != logBefore+1+logAfter {
		t.Fatalf("window: error at %d, %d lines", got.ErrorLine, len(got.Lines))
	}
	if strings.HasPrefix(got.Lines[got.ErrorLine-1], "2026-") || got.Lines[got.ErrorLine-1] != "--- FAIL: TestDeck (0.01s)" {
		t.Fatalf("timestamp kept: %q", got.Lines[got.ErrorLine-1])
	}
	// Kept: a finished log does not change.
	before := len(x.f.requests())
	if _, e := x.s.JobLog(context.Background(), repo, 71); e != nil || len(x.f.requests()) != before {
		t.Fatal("asked again for a log already read")
	}
}

// A redirect anywhere but GitHub's log storage is not followed.
func TestJobLogRefusesAStrangeHost(t *testing.T) {
	x := newFixture(t)
	x.connect(t)
	x.f.failWith("GET /repos/ada/caprock/actions/jobs/9/logs", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Location", "https://evil.example/logs/9")
		w.WriteHeader(http.StatusFound)
	})
	if _, e := x.s.JobLog(context.Background(), Repo{Owner: "ada", Name: "caprock"}, 9); e == nil || !strings.Contains(e.Message, "evil.example") {
		t.Fatalf("followed: %v", e)
	}
	for _, ok := range []string{"https://pipelines.actions.githubusercontent.com/x", "https://productionresultssa1.blob.core.windows.net/x?sig=1"} {
		if !x.s.logHost(ok) {
			t.Errorf("%s refused", ok)
		}
	}
	for _, bad := range []string{"http://pipelines.actions.githubusercontent.com/x", "https://actions.githubusercontent.com.evil.example/x", ""} {
		if x.s.logHost(bad) {
			t.Errorf("%s allowed", bad)
		}
	}
}

func TestTailWithoutAnError(t *testing.T) {
	var b strings.Builder
	for i := 0; i < 100; i++ {
		fmt.Fprintf(&b, "l%d\n", i)
	}
	lines, at := tailAroundError(strings.NewReader(b.String()))
	if at != -1 || len(lines) != logBefore+logAfter || lines[len(lines)-1] != "l99" {
		t.Fatalf("%d %d %v", at, len(lines), lines[len(lines)-1])
	}
	long := strings.Repeat("é", 1000)
	if c := cleanLogLine(long); !strings.HasSuffix(c, "…") || len(c) > logLineMax+len("…") || !strings.HasPrefix(c, "é") {
		t.Fatalf("clipped badly: %d", len(c))
	}
}
