package github

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"
)

func rateTable(t *testing.T) *RunnerTable {
	t.Helper()
	tb, err := EmbeddedRunnerTable()
	if err != nil {
		t.Fatal(err)
	}
	return tb
}

// rate is a SKU's rate from the table: no price is written in Go, tests
// included.
func rate(t *testing.T, sku string) float64 {
	t.Helper()
	s, ok := rateTable(t).bySKU[sku]
	if !ok {
		t.Fatalf("no SKU %s", sku)
	}
	return s.USDMin
}

// The embedded table loads, names its source and date, prices every SKU,
// and every label it documents names a SKU it has.
func TestRunnerTableLoads(t *testing.T) {
	tb := rateTable(t)
	if tb.Version == "" || !strings.HasPrefix(tb.Source, "https://docs.github.com/") || tb.FetchedAt == "" {
		t.Fatalf("version %q source %q fetched %q", tb.Version, tb.Source, tb.FetchedAt)
	}
	if _, err := time.Parse("2006-01-02", tb.FetchedAt); err != nil {
		t.Fatalf("fetched_at: %v", err)
	}
	for _, s := range tb.SKUs {
		if s.USDMin <= 0 || s.Display == "" || s.OS == "" {
			t.Errorf("row %+v", s)
		}
	}
	for _, sku := range []string{"actions_linux", "actions_windows", "actions_macos", "linux_4_core", "linux_4_core_arm", "macos_xl", "linux_4_core_gpu"} {
		if _, ok := tb.bySKU[sku]; !ok {
			t.Errorf("no %s", sku)
		}
	}
	for _, bad := range []string{
		`{"unit":"per_minute","currency":"USD","skus":[{"sku":"a","usd_per_min":1}]}`,
		`{"version":"x","unit":"per_minute","currency":"USD","skus":[]}`,
		`{"version":"x","unit":"per_hour","currency":"USD","skus":[{"sku":"a","usd_per_min":1}]}`,
		`{"version":"x","unit":"per_minute","currency":"USD","skus":[{"sku":"a","usd_per_min":-1}]}`,
		`{"version":"x","unit":"per_minute","currency":"USD","skus":[{"sku":"a","usd_per_min":1},{"sku":"a","usd_per_min":2}]}`,
		`{"version":"x","unit":"per_minute","currency":"USD","skus":[{"sku":"a","usd_per_min":1}],"labels":{"ubuntu-latest":"b"}}`,
		`{`,
	} {
		if _, err := ParseRunnerTable([]byte(bad)); err == nil {
			t.Errorf("accepted %s", bad)
		}
	}
}

func TestRunnerSKUMapping(t *testing.T) {
	tb := rateTable(t)
	for _, c := range []struct {
		labels []string
		name   string
		sku    string
		match  string
		why    string
	}{
		{[]string{"ubuntu-latest"}, "GitHub Actions 3", "actions_linux", MatchLabel, ""},
		{[]string{"ubuntu-24.04"}, "", "actions_linux", MatchLabel, ""},
		{[]string{"Ubuntu-22.04"}, "", "actions_linux", MatchLabel, ""},
		{[]string{"ubuntu-slim"}, "", "actions_linux_slim", MatchLabel, ""},
		{[]string{"ubuntu-24.04-arm"}, "", "actions_linux_arm", MatchLabel, ""},
		{[]string{"windows-latest"}, "", "actions_windows", MatchLabel, ""},
		{[]string{"windows-11-arm"}, "", "actions_windows_arm", MatchLabel, ""},
		{[]string{"macos-latest"}, "", "actions_macos", MatchLabel, ""},
		{[]string{"macos-14"}, "", "actions_macos", MatchLabel, ""},
		{[]string{"macos-15-intel"}, "", "actions_macos", MatchLabel, ""},
		{[]string{"macos-latest-large"}, "", "macos_l", MatchLabel, ""},
		{[]string{"macos-15-xlarge"}, "", "macos_xl", MatchLabel, ""},
		{[]string{"ubuntu-latest-4-cores"}, "", "linux_4_core", MatchName, ""},
		{[]string{"ubuntu-24.04-16core"}, "", "linux_16_core", MatchName, ""},
		{[]string{"linux-8-core-arm"}, "", "linux_8_core_arm", MatchName, ""},
		{[]string{"windows-latest-8-cores"}, "", "windows_8_core", MatchName, ""},
		{[]string{"windows-4-cores-arm64"}, "", "windows_4_core_arm", MatchName, ""},
		{nil, "ubuntu-latest-32-cores", "linux_32_core", MatchName, ""},
		// A name that spells no SKU in the table is not rounded to a near one.
		{[]string{"ubuntu-latest-2-cores"}, "", "", "", UnpricedUnknown},
		{[]string{"ubuntu-latest-12-cores"}, "", "", "", UnpricedUnknown},
		{[]string{"gpu-box"}, "", "", "", UnpricedUnknown},
		{[]string{"big-box"}, "big-box-1", "", "", UnpricedUnknown},
		{nil, "", "", "", UnpricedUnknown},
		{[]string{"self-hosted", "linux", "x64"}, "mac-mini", "", "", UnpricedSelfHosted},
		// Self-hosted wins even over a label GitHub also uses.
		{[]string{"self-hosted", "ubuntu-latest"}, "", "", "", UnpricedSelfHosted},
	} {
		s, match, why := tb.runnerSKU(c.labels, c.name)
		if s.SKU != c.sku || match != c.match || why != c.why {
			t.Errorf("%v %q: %q %q %q, want %q %q %q", c.labels, c.name, s.SKU, match, why, c.sku, c.match, c.why)
		}
	}
}

func TestBilledMinutesRoundUp(t *testing.T) {
	for ms, want := range map[int64]int64{0: 0, -5: 0, 1: 1, 59_999: 1, 60_000: 1, 60_001: 2, 90_000: 2, 600_000: 10, 600_001: 11} {
		if got := billedMinutes(ms); got != want {
			t.Errorf("%d ms: %d, want %d", ms, got, want)
		}
	}
}

func job(labels []string, status string, ms int64) CIJob {
	return CIJob{Labels: labels, Status: status, DurationMS: ms}
}

func TestRunnerCost(t *testing.T) {
	tb := rateTable(t)
	// Private: each job rounded up on its own, at its SKU's rate.
	c := tb.Cost(job([]string{"ubuntu-latest"}, "completed", 90_000), VisibilityPrivate)
	if !c.Priced || c.SKU != "actions_linux" || c.MinutesBilled != 2 || c.USD != usd(2*rate(t, "actions_linux")) || c.FreePublic {
		t.Fatalf("private linux %+v", c)
	}
	// Public on a standard runner: free, the minutes still said.
	c = tb.Cost(job([]string{"macos-latest"}, "completed", 61_000), VisibilityPublic)
	if !c.Priced || !c.FreePublic || c.USD != 0 || c.MinutesBilled != 2 {
		t.Fatalf("public macos %+v", c)
	}
	// A larger runner is charged in a public repository too.
	c = tb.Cost(job([]string{"ubuntu-latest-4-cores"}, "completed", 60_000), VisibilityPublic)
	if !c.Priced || c.FreePublic || !c.Larger || c.USD != usd(rate(t, "linux_4_core")) {
		t.Fatalf("public larger %+v", c)
	}
	// Unknown visibility is priced at the list rate.
	c = tb.Cost(job([]string{"windows-latest"}, "completed", 300_000), VisibilityUnknown)
	if !c.Priced || c.FreePublic || c.USD != usd(5*rate(t, "actions_windows")) {
		t.Fatalf("unknown visibility %+v", c)
	}
	for _, x := range []struct {
		j   CIJob
		why string
	}{
		{job([]string{"self-hosted"}, "completed", 60_000), UnpricedSelfHosted},
		{job([]string{"my-runner"}, "completed", 60_000), UnpricedUnknown},
		{job([]string{"ubuntu-latest"}, "in_progress", 0), UnpricedUnfinished},
		{job([]string{"my-runner"}, "queued", 0), UnpricedUnfinished},
	} {
		if c := tb.Cost(x.j, VisibilityPrivate); c.Priced || c.Reason != x.why || c.USD != 0 {
			t.Errorf("%+v: %+v, want %s", x.j, c, x.why)
		}
	}
	var none *RunnerTable
	if c := none.Cost(job([]string{"ubuntu-latest"}, "completed", 60_000), VisibilityPrivate); c.Priced || c.Reason != UnpricedNoTable {
		t.Fatalf("no table %+v", c)
	}
}

func TestPriceRunsSums(t *testing.T) {
	tb := rateTable(t)
	runs := []CIRun{
		{ID: 1, Jobs: []CIJob{
			job([]string{"ubuntu-latest"}, "completed", 90_000),  // 2 min
			job([]string{"windows-latest"}, "completed", 1_000),  // 1 min
			job([]string{"self-hosted"}, "completed", 120_000),   // unpriced, 2 min
			job([]string{"ubuntu-latest"}, "completed", 0),       // skipped: 0 min
			job([]string{"macos-latest"}, "in_progress", 30_000), // unfinished
		}},
		{ID: 2, Jobs: []CIJob{job([]string{"macos-latest-xlarge"}, "completed", 600_000)}}, // 10 min
	}
	total := tb.PriceRuns(runs, VisibilityPrivate)
	r1 := usd(2*rate(t, "actions_linux") + rate(t, "actions_windows"))
	if c := runs[0].Cost; c.USD != r1 || c.MinutesBilled != 3 || c.UnpricedMinutes != 2 || c.UnpricedJobs != 1 || c.UnfinishedJobs != 1 || c.PricedJobs != 3 || !c.Partial {
		t.Fatalf("run 1 %+v (want $%v)", c, r1)
	}
	if runs[0].Jobs[0].Cost == nil || runs[0].Jobs[0].Cost.MinutesBilled != 2 {
		t.Fatalf("job cost not set: %+v", runs[0].Jobs[0].Cost)
	}
	r2 := usd(10 * rate(t, "macos_xl"))
	if c := runs[1].Cost; c.USD != r2 || c.Partial {
		t.Fatalf("run 2 %+v", c)
	}
	if total.USD != usd(r1+r2) || total.MinutesBilled != 13 || !total.Partial || total.Visibility != VisibilityPrivate || total.TableVersion != tb.Version || total.TableSource != tb.Source || runs[0].Cost.TableSource != tb.Source {
		t.Fatalf("total %+v", total)
	}
	// Public: the standard minutes are free, the larger runner's are not.
	total = tb.PriceRuns(runs, VisibilityPublic)
	if total.USD != r2 || total.FreeMinutes != 3 || total.MinutesBilled != 10 {
		t.Fatalf("public total %+v", total)
	}
	if total = tb.PriceRuns(nil, ""); total.Visibility != VisibilityUnknown || total.USD != 0 || total.Partial {
		t.Fatalf("empty %+v", total)
	}
}

// A commit's CI carries the cost of each job, run and the whole, at the
// repository's visibility read once from GET /repos/{o}/{r} and kept.
func TestCIBySHAPricesJobs(t *testing.T) {
	x := newFixture(t)
	x.connect(t)
	repo := Repo{Owner: "ada", Name: "caprock"}
	x.f.failWith("GET /repos/ada/caprock", func(w http.ResponseWriter, r *http.Request) {
		answer(w, r, 200, map[string]any{"full_name": "ada/caprock", "private": true, "default_branch": "main"})
	})
	x.f.failWith("GET /repos/ada/caprock/actions/runs", func(w http.ResponseWriter, r *http.Request) {
		answer(w, r, 200, map[string]any{"workflow_runs": []any{actionsRun(7, "completed", "success", "2026-10-11T10:09:00Z")}})
	})
	x.f.failWith("GET /repos/ada/caprock/actions/runs/7/jobs", func(w http.ResponseWriter, r *http.Request) {
		answer(w, r, 200, map[string]any{"jobs": []any{
			map[string]any{"id": 70, "run_id": 7, "name": "lint", "status": "completed", "conclusion": "success", "started_at": "2026-10-11T10:00:30Z",
				"completed_at": "2026-10-11T10:02:00Z", "labels": []any{"ubuntu-latest"}, "runner_group_name": "GitHub Actions"},
			map[string]any{"id": 71, "run_id": 7, "name": "deploy", "status": "completed", "conclusion": "success", "started_at": "2026-10-11T10:00:00Z",
				"completed_at": "2026-10-11T10:05:00Z", "labels": []any{"self-hosted", "linux"}, "runner_group_name": "Default"},
		}})
	})
	ci, e := x.s.CIBySHA(context.Background(), repo, "sha1")
	if e != nil {
		t.Fatal(e)
	}
	lint := ci.Runs[0].Jobs[0]
	if lint.RunnerGroup != "GitHub Actions" || lint.Cost == nil || lint.Cost.SKU != "actions_linux" || lint.Cost.USD != usd(2*rate(t, "actions_linux")) {
		t.Fatalf("lint %+v %+v", lint, lint.Cost)
	}
	if c := ci.Runs[0].Jobs[1].Cost; c == nil || c.Priced || c.Reason != UnpricedSelfHosted {
		t.Fatalf("self-hosted %+v", c)
	}
	if ci.Cost == nil || ci.Cost.Visibility != VisibilityPrivate || ci.Cost.USD != lint.Cost.USD || ci.Cost.UnpricedMinutes != 5 || !ci.Cost.Partial {
		t.Fatalf("total %+v", ci.Cost)
	}
	if ci.Runs[0].Cost == nil || ci.Runs[0].Cost.USD != ci.Cost.USD {
		t.Fatalf("run %+v", ci.Runs[0].Cost)
	}
	// The visibility is kept with the default branch: no second read.
	x.advance(ciSettled + time.Second)
	_, _ = x.s.CIBySHA(context.Background(), repo, "sha1")
	n := 0
	for _, r := range x.f.requests() {
		if r == "GET /repos/ada/caprock" || strings.HasPrefix(r, "GET /repos/ada/caprock [") {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("visibility read %d times", n)
	}
	if b, e := x.s.DefaultBranch(context.Background(), repo); e != nil || b != "main" {
		t.Fatalf("default branch %q %v", b, e)
	}
}

// A repository whose metadata cannot be read is priced as unknown, and not
// asked about on every CI read.
func TestRepoVisibilityUnknownIsKept(t *testing.T) {
	x := newFixture(t)
	x.connect(t)
	repo := Repo{Owner: "ada", Name: "secret"}
	if v := x.s.RepoVisibility(context.Background(), repo); v != VisibilityUnknown {
		t.Fatalf("%q", v)
	}
	before := len(x.f.requests())
	x.advance(time.Minute)
	if v := x.s.RepoVisibility(context.Background(), repo); v != VisibilityUnknown || len(x.f.requests()) != before {
		t.Fatal("asked again at once")
	}
	x.f.failWith("GET /repos/ada/secret", func(w http.ResponseWriter, r *http.Request) {
		answer(w, r, 200, map[string]any{"full_name": "ada/secret", "private": false, "default_branch": "trunk"})
	})
	x.advance(visibilityKept)
	if v := x.s.RepoVisibility(context.Background(), repo); v != VisibilityPublic {
		t.Fatalf("after the wait: %q", v)
	}
}
