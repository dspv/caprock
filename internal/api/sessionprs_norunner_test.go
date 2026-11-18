package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"
)

// A pull request whose only non-passing check is a job GitHub never gave a
// machine (run 44324234291, 2026-11-18): the session's PRs say no_runner,
// not fail, the check carries no_runner, and the deck's Re-run asks GitHub
// to re-run that run's failed jobs, as for a real failure.
func TestSessionPRsNoRunner(t *testing.T) {
	var mu sync.Mutex
	var posted []string
	s, _, _, _, _, _ := githubServer(t, func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if r.Method != http.MethodGet && r.URL.Path != "/user" {
			posted = append(posted, r.Method+" "+r.URL.Path)
		}
		switch {
		case r.URL.Path == "/repos/ada/repo/pulls/5" && r.Method == http.MethodGet:
			_, _ = w.Write([]byte(`{"number":5,"html_url":"https://github.com/ada/repo/pull/5","title":"Add x","state":"open","mergeable":true,"head":{"ref":"feat/x","sha":"h1"},"base":{"ref":"main"}}`))
		case r.URL.Path == "/repos/ada/repo/commits/h1/check-runs":
			_, _ = w.Write([]byte(`{"total_count":2,"check_runs":[` +
				`{"name":"go (ubuntu-latest)","status":"completed","conclusion":"success","html_url":"https://github.com/ada/repo/actions/runs/7/job/70","started_at":"2026-11-18T14:26:25Z","completed_at":"2026-11-18T14:30:00Z"},` +
				`{"name":"go (macos-latest)","status":"completed","conclusion":"cancelled","html_url":"https://github.com/ada/repo/actions/runs/7/job/71","started_at":"2026-11-18T14:26:25Z","completed_at":"2026-11-18T14:41:27Z"}]}`))
		case r.URL.Path == "/repos/ada/repo/commits/h1/status":
			_, _ = w.Write([]byte(`{"state":"success","statuses":[]}`))
		case r.URL.Path == "/repos/ada/repo/actions/runs" && r.Method == http.MethodGet:
			_, _ = w.Write([]byte(`{"total_count":1,"workflow_runs":[{"id":7,"name":"ci","status":"completed","conclusion":"failure","head_sha":"h1"}]}`))
		case r.URL.Path == "/repos/ada/repo/actions/runs/7/jobs":
			_, _ = w.Write([]byte(`{"total_count":2,"jobs":[` +
				`{"id":70,"run_id":7,"name":"go (ubuntu-latest)","status":"completed","conclusion":"success","labels":["ubuntu-latest"],"runner_id":12,"runner_name":"GitHub Actions 12","steps":[{"number":1,"name":"go test","status":"completed","conclusion":"success"}]},` +
				`{"id":71,"run_id":7,"name":"go (macos-latest)","status":"completed","conclusion":"cancelled","labels":["macos-latest"],"runner_id":0,"runner_name":"","steps":[]}]}`))
		case r.URL.Path == "/repos/ada/repo/actions/runs/7/rerun-failed-jobs":
			w.WriteHeader(http.StatusCreated)
		default:
			fakeRoutes(w, r)
		}
	})
	if _, err := s.d.Store.DB().Exec(`INSERT INTO session_prs (session_id, url, number, title, last_at) VALUES ('s9', 'https://github.com/ada/repo/pull/5', 5, 'Add x', 1)`); err != nil {
		t.Fatal(err)
	}
	call(t, s, machine, "", "POST", "/v1/github/connect", `{"source":"token","token":"ghp_good"}`)
	w := call(t, s, machine, "", "GET", "/v1/sessions/s9/prs", "")
	if w.Code != http.StatusOK {
		t.Fatalf("prs: %d %s", w.Code, w.Body.String())
	}
	var got struct {
		PRs []struct {
			Number int `json:"number"`
			Live   *struct {
				Checks struct {
					State    string `json:"state"`
					Failed   int    `json:"failed"`
					NoRunner int    `json:"no_runner"`
					Items    []struct {
						Name     string `json:"name"`
						State    string `json:"state"`
						NoRunner bool   `json:"no_runner"`
					} `json:"items"`
				} `json:"checks"`
			} `json:"live"`
		} `json:"prs"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if len(got.PRs) != 1 || got.PRs[0].Live == nil {
		t.Fatalf("prs: %s", w.Body.String())
	}
	c := got.PRs[0].Live.Checks
	if c.State != "no_runner" || c.Failed != 0 || c.NoRunner != 1 || len(c.Items) != 2 || c.Items[0].NoRunner || !c.Items[1].NoRunner || c.Items[1].State != "fail" {
		t.Fatalf("checks: %+v", c)
	}
	w = call(t, s, machine, "", "POST", "/v1/sessions/s9/prs/5/rerun", "")
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"mode":"failed"`) || !strings.Contains(w.Body.String(), `"jobs":1`) {
		t.Fatalf("rerun: %d %s", w.Code, w.Body.String())
	}
	mu.Lock()
	defer mu.Unlock()
	if strings.Join(posted, ",") != "POST /repos/ada/repo/actions/runs/7/rerun-failed-jobs" {
		t.Fatalf("GitHub was asked: %v", posted)
	}
}
