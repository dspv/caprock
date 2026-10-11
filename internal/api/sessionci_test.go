package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/dspv/caprock/internal/store"
)

// ciRoutes is a GitHub with pull request #5 (head sha5) and one failed run.
func ciRoutes(base *string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/_logs/71" {
			_, _ = w.Write([]byte("2026-10-11T10:00:00.0000000Z go test ./...\n2026-10-11T10:00:01.0000000Z ##[error]Process completed with exit code 1.\n"))
			return
		}
		if r.Header.Get("Authorization") != "Bearer ghp_good" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("X-OAuth-Scopes", "repo")
		switch r.URL.Path {
		case "/user":
			_, _ = w.Write([]byte(`{"login":"ada"}`))
		case "/repos/ada/repo/pulls/5":
			_, _ = w.Write([]byte(`{"number":5,"html_url":"https://github.com/ada/repo/pull/5","title":"Add x","state":"open","head":{"ref":"feat/x","sha":"sha5"},"base":{"ref":"main"}}`))
		case "/repos/ada/repo/actions/runs":
			_, _ = w.Write([]byte(`{"workflow_runs":[{"id":7,"name":"CI","status":"completed","conclusion":"failure","updated_at":"2026-10-11T10:09:00Z"}]}`))
		case "/repos/ada/repo/actions/runs/7/jobs":
			_, _ = w.Write([]byte(`{"jobs":[{"id":71,"run_id":7,"name":"test","status":"completed","conclusion":"failure","started_at":"2026-10-11T10:00:00Z","completed_at":"2026-10-11T10:03:00Z","labels":["macos-14"],
				"steps":[{"number":1,"name":"go test","status":"completed","conclusion":"failure","started_at":"2026-10-11T10:00:00Z","completed_at":"2026-10-11T10:03:00Z"}]}]}`))
		case "/repos/ada/repo/actions/jobs/71/logs":
			w.Header().Set("Location", *base+"/_logs/71")
			w.WriteHeader(http.StatusFound)
		default:
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"message":"Not Found"}`))
		}
	}
}

// The deck's CI panel reads the session's PR's Actions runs with their jobs
// and steps, and a failed job's log tail on demand; nothing while GitHub is
// not connected, and no job outside the session's CI.
func TestSessionCI(t *testing.T) {
	var base string
	s, _, _, _, _, _ := githubServer(t, ciRoutes(&base))
	base = s.d.GitHub.API
	if err := store.RecordPR(context.Background(), s.d.Store.DB(), store.PRAction{SessionID: "s1", URL: "https://github.com/ada/repo/pull/5", Number: 5, Title: "Add x", Action: "created", Ts: 1}); err != nil {
		t.Fatal(err)
	}
	w := call(t, s, machine, "", "GET", "/v1/sessions/s1/ci", "")
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"connected":false`) || strings.Contains(w.Body.String(), `"ci"`) || !strings.Contains(w.Body.String(), `"number":5`) {
		t.Fatalf("not connected: %d %s", w.Code, w.Body.String())
	}
	if w := call(t, s, machine, "", "POST", "/v1/github/connect", `{"source":"token","token":"ghp_good"}`); w.Code != http.StatusOK {
		t.Fatalf("connect: %d %s", w.Code, w.Body.String())
	}
	w = call(t, s, machine, "", "GET", "/v1/sessions/s1/ci", "")
	var got SessionCI
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil || w.Code != http.StatusOK {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	if got.PR == nil || got.PR.HeadSHA != "sha5" || got.CI == nil || got.CI.State != "fail" || got.CI.RunnerMS != 180_000 || got.CI.ByOS[0].OS != "macos" {
		t.Fatalf("%s", w.Body.String())
	}
	if job := got.CI.Runs[0].Jobs[0]; job.Steps[0].Conclusion != "failure" || job.Steps[0].DurationMS != 180_000 {
		t.Fatalf("%+v", job)
	}
	w = call(t, s, machine, "", "GET", "/v1/sessions/s1/ci/jobs/71/log", "")
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `##[error]Process completed`) || !strings.Contains(w.Body.String(), `"error_line":1`) {
		t.Fatalf("log: %d %s", w.Code, w.Body.String())
	}
	// The PR asked for by number (a click on its mini pipeline), its job's log in that view.
	if w := call(t, s, machine, "", "GET", "/v1/sessions/s1/ci?pr=5", ""); w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"number":5`) || !strings.Contains(w.Body.String(), `"ci"`) {
		t.Fatalf("?pr=5: %d %s", w.Code, w.Body.String())
	}
	if w := call(t, s, machine, "", "GET", "/v1/sessions/s1/ci/jobs/71/log?view=pr&pr=5", ""); w.Code != http.StatusOK {
		t.Fatalf("log ?pr=5: %d %s", w.Code, w.Body.String())
	}
	if w := call(t, s, machine, "", "GET", "/v1/sessions/s1/ci/jobs/99/log", ""); w.Code != http.StatusNotFound {
		t.Fatalf("a job outside the session's CI: %d %s", w.Code, w.Body.String())
	}
	if w := call(t, s, machine, "", "GET", "/v1/sessions/nobody/ci", ""); w.Code != http.StatusOK || strings.Contains(w.Body.String(), `"pr"`) {
		t.Fatalf("no PR: %d %s", w.Code, w.Body.String())
	}
}
