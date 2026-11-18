package github

import (
	"context"
	"net/http"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

const rerunPost = "POST /repos/ada/caprock/actions/runs/7/rerun-failed-jobs"

// starvedFixture is a connected fixture at 15:00 on 2026-11-18, when run 7
// (attempt 1, ended 14:41) has one job that passed and one GitHub never
// gave a machine; re-running its failed jobs answers 201.
func starvedFixture(t *testing.T, file string) *fixture {
	t.Helper()
	x := newFixture(t)
	x.s.AutoRerunFile = file
	x.now = time.Date(2026, 11, 18, 15, 0, 0, 0, time.UTC)
	x.connect(t)
	runsWith(x, []map[string]any{actionsRun(7, "completed", "cancelled", "2026-11-18T14:41:30Z")},
		map[string][]any{"7": {ranJob(70, 7, "success"), idleJob(71, 7, "cancelled")}})
	x.f.failWith(rerunPost, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(201) })
	return x
}

func (x *fixture) autoRerunOn() {
	x.cfg.mu.Lock()
	x.cfg.rerun = true
	x.cfg.mu.Unlock()
}

// Off by default: a starved run is shown, never re-run by Caprock.
func TestAutoRerunOffByDefault(t *testing.T) {
	x := starvedFixture(t, "")
	if x.s.Status().AutoRerun {
		t.Fatal("auto_rerun on by default")
	}
	ci, e := x.s.CIBySHA(context.Background(), Repo{Owner: "ada", Name: "caprock"}, "sha1")
	if e != nil {
		t.Fatal(e)
	}
	if p := posts(x, rerunPost); len(p) != 0 {
		t.Fatalf("re-run while off: %v", p)
	}
	if ci.State != "no_runner" || ci.Runs[0].AutoRerun != nil {
		t.Fatalf("ci: %+v", ci)
	}
}

// On: the run's failed jobs are re-run once, the run says so, and a later
// read — of the same run, starved again on its next attempt — asks nothing
// more and says it was given no machine again.
func TestAutoRerunOncePerRun(t *testing.T) {
	x := starvedFixture(t, "")
	x.autoRerunOn()
	repo := Repo{Owner: "ada", Name: "caprock"}
	ci, e := x.s.CIBySHA(context.Background(), repo, "sha1")
	if e != nil {
		t.Fatal(e)
	}
	if p := posts(x, rerunPost); len(p) != 1 {
		t.Fatalf("posts: %v", p)
	}
	a := ci.Runs[0].AutoRerun
	if a == nil || a.Attempt != 1 || a.Jobs != 1 || a.Again || a.Error != "" {
		t.Fatalf("auto_rerun: %+v", a)
	}
	// Forgotten after the re-run: the next read asks GitHub again.
	before := len(posts(x, "GET /repos/ada/caprock/actions/runs?"))
	// GitHub gave attempt 2 no machine either.
	run := actionsRun(7, "completed", "cancelled", "2026-11-18T14:58:00Z")
	run["run_attempt"] = 2
	again := idleJob(72, 7, "cancelled")
	again["started_at"], again["completed_at"] = "2026-11-18T14:42:00Z", "2026-11-18T14:57:59Z"
	runsWith(x, []map[string]any{run}, map[string][]any{"7": {ranJob(70, 7, "success"), again}})
	ci, e = x.s.CIBySHA(context.Background(), repo, "sha1")
	if e != nil {
		t.Fatal(e)
	}
	if after := len(posts(x, "GET /repos/ada/caprock/actions/runs?")); after != before+1 {
		t.Fatalf("not read again after the re-run: %d -> %d", before, after)
	}
	if p := posts(x, rerunPost); len(p) != 1 {
		t.Fatalf("re-run twice: %v", p)
	}
	if a := ci.Runs[0].AutoRerun; a == nil || !a.Again || a.Attempt != 1 {
		t.Fatalf("starved again: %+v", a)
	}
	x.advance(ciSettled)
	if _, e := x.s.CIBySHA(context.Background(), repo, "sha1"); e != nil {
		t.Fatal(e)
	}
	if p := posts(x, rerunPost); len(p) != 1 {
		t.Fatalf("re-run on a later read: %v", p)
	}
}

// A run with a real failure is the user's: nothing is re-run, and neither
// is one someone cancelled within minutes, nor one that ended hours ago.
func TestAutoRerunOnlyStarvedRuns(t *testing.T) {
	repo := Repo{Owner: "ada", Name: "caprock"}
	for _, c := range []struct {
		name string
		jobs []any
		now  time.Time
	}{
		{"a real failure beside it", []any{ranJob(70, 7, "failure"), idleJob(71, 7, "cancelled")}, time.Time{}},
		{"cancelled within minutes", []any{ranJob(70, 7, "success"), func() map[string]any {
			j := idleJob(71, 7, "cancelled")
			j["completed_at"] = "2026-11-18T14:28:00Z"
			return j
		}()}, time.Time{}},
		{"ended hours ago", nil, time.Date(2026, 11, 18, 21, 0, 0, 0, time.UTC)},
	} {
		t.Run(c.name, func(t *testing.T) {
			x := starvedFixture(t, "")
			x.autoRerunOn()
			if c.jobs != nil {
				runsWith(x, []map[string]any{actionsRun(7, "completed", "failure", "2026-11-18T14:41:30Z")}, map[string][]any{"7": c.jobs})
			}
			if !c.now.IsZero() {
				x.now = c.now
			}
			ci, e := x.s.CIBySHA(context.Background(), repo, "sha1")
			if e != nil {
				t.Fatal(e)
			}
			if p := posts(x, rerunPost); len(p) != 0 {
				t.Fatalf("re-run: %v", p)
			}
			if ci.Runs[0].AutoRerun != nil {
				t.Fatalf("marked: %+v", ci.Runs[0].AutoRerun)
			}
		})
	}
}

// What was re-run is written down before GitHub is asked, so a daemon
// started again neither asks again nor forgets to say it.
func TestAutoRerunSurvivesRestart(t *testing.T) {
	file := filepath.Join(t.TempDir(), "ci-auto-rerun.json")
	repo := Repo{Owner: "ada", Name: "caprock"}
	x := starvedFixture(t, file)
	x.autoRerunOn()
	if _, e := x.s.CIBySHA(context.Background(), repo, "sha1"); e != nil {
		t.Fatal(e)
	}
	if p := posts(x, rerunPost); len(p) != 1 {
		t.Fatalf("posts: %v", p)
	}

	y := starvedFixture(t, file) // GitHub still shows attempt 1 starved
	y.autoRerunOn()
	ci, e := y.s.CIBySHA(context.Background(), repo, "sha1")
	if e != nil {
		t.Fatal(e)
	}
	if p := posts(y, rerunPost); len(p) != 0 {
		t.Fatalf("re-run again after a restart: %v", p)
	}
	if a := ci.Runs[0].AutoRerun; a == nil || a.Attempt != 1 {
		t.Fatalf("after a restart: %+v", a)
	}
}

// A refused re-run is said, and not asked again.
func TestAutoRerunRefusedOnce(t *testing.T) {
	x := starvedFixture(t, "")
	x.autoRerunOn()
	var mu sync.Mutex
	n := 0
	x.f.failWith(rerunPost, func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		n++
		mu.Unlock()
		answer(w, r, 403, map[string]any{"message": "Resource not accessible by personal access token"})
	})
	repo := Repo{Owner: "ada", Name: "caprock"}
	ci, e := x.s.CIBySHA(context.Background(), repo, "sha1")
	if e != nil {
		t.Fatal(e)
	}
	if a := ci.Runs[0].AutoRerun; a == nil || a.Error == "" {
		t.Fatalf("refusal not said: %+v", a)
	}
	x.advance(ciSettled)
	if _, e := x.s.CIBySHA(context.Background(), repo, "sha1"); e != nil {
		t.Fatal(e)
	}
	mu.Lock()
	defer mu.Unlock()
	if n != 1 {
		t.Fatalf("asked %d times", n)
	}
}

// An open pull request whose checks say no_runner has its run re-run from
// the pull request read, and its checks carry the re-run; a merged one is
// left alone.
func TestAutoRerunFromPullRequestChecks(t *testing.T) {
	x := starvedFixture(t, "")
	x.autoRerunOn()
	x.f.mu.Lock()
	x.f.pulls["ada/caprock"] = []map[string]any{pull("ada/caprock", 3, "feat/x", "sha1")}
	x.f.runs["sha1"] = []map[string]any{checkRun("go (ubuntu-latest)", "success", 7, 70), checkRun("go (macos-latest)", "cancelled", 7, 71)}
	x.f.mu.Unlock()
	pr, e := x.s.PullByURL(context.Background(), "https://github.com/ada/caprock/pull/3")
	if e != nil {
		t.Fatal(e)
	}
	if p := posts(x, rerunPost); len(p) != 1 {
		t.Fatalf("posts: %v", p)
	}
	if a := pr.Checks.AutoRerun; pr.Checks.State != "no_runner" || a == nil || a.Again {
		t.Fatalf("checks: %+v", pr.Checks)
	}

	m := starvedFixture(t, "")
	m.autoRerunOn()
	merged := pull("ada/caprock", 4, "feat/y", "sha1")
	merged["state"], merged["merged_at"] = "closed", "2026-11-18T14:50:00Z"
	m.f.mu.Lock()
	m.f.pulls["ada/caprock"] = []map[string]any{merged}
	m.f.runs["sha1"] = []map[string]any{checkRun("go (ubuntu-latest)", "success", 7, 70), checkRun("go (macos-latest)", "cancelled", 7, 71)}
	m.f.mu.Unlock()
	if _, e := m.s.PullByURL(context.Background(), "https://github.com/ada/caprock/pull/4"); e != nil {
		t.Fatal(e)
	}
	if p := posts(m, rerunPost); len(p) != 0 {
		t.Fatalf("a merged pull request was re-run: %v", p)
	}
}

// The deck's own Rerun is not doubled by Caprock's while the switch is on.
func TestAutoRerunLeavesTheButtonAlone(t *testing.T) {
	x := starvedFixture(t, "")
	x.autoRerunOn()
	if _, e := x.s.RerunChecks(context.Background(), Repo{Owner: "ada", Name: "caprock"}, "sha1"); e != nil {
		t.Fatal(e)
	}
	if p := posts(x, rerunPost); len(p) != 1 {
		t.Fatalf("posts: %v", p)
	}
}

// The switch is saved and reported.
func TestSetAutoRerun(t *testing.T) {
	x := newFixture(t)
	st, err := x.s.SetAutoRerun(true)
	if err != nil || !st.AutoRerun {
		t.Fatalf("%+v %v", st, err)
	}
	if st, _ = x.s.SetAutoRerun(false); st.AutoRerun {
		t.Fatal("still on")
	}
}
