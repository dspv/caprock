package api

import (
	"net/http"
	"strings"
	"sync"
	"testing"
)

// The deck's force actions: re-run a PR's checks and update its branch, only
// on a pull request the session recorded, only from the machine, and a
// refusal names the permission the token lacks.
func TestSessionPRForceActions(t *testing.T) {
	var mu sync.Mutex
	var posted []string
	mergeable := "true"
	deny := false
	s, _, controller, _, _, _ := githubServer(t, func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if r.Method != http.MethodGet && r.URL.Path != "/user" {
			posted = append(posted, r.Method+" "+r.URL.Path)
		}
		switch {
		case r.URL.Path == "/repos/ada/repo/pulls/5" && r.Method == http.MethodGet:
			_, _ = w.Write([]byte(`{"number":5,"html_url":"https://github.com/ada/repo/pull/5","title":"Add x","state":"open","mergeable":` + mergeable + `,"mergeable_state":"behind","head":{"ref":"feat/x","sha":"h1"},"base":{"ref":"main"}}`))
		case r.URL.Path == "/repos/ada/repo/actions/runs" && r.Method == http.MethodGet:
			_, _ = w.Write([]byte(`{"total_count":1,"workflow_runs":[{"id":7,"name":"CI","status":"completed","conclusion":"failure","head_sha":"h1"}]}`))
		case r.URL.Path == "/repos/ada/repo/actions/runs/7/jobs":
			_, _ = w.Write([]byte(`{"total_count":2,"jobs":[{"id":70,"run_id":7,"name":"lint","status":"completed","conclusion":"success","labels":[],"steps":[]},{"id":71,"run_id":7,"name":"test","status":"completed","conclusion":"failure","labels":[],"steps":[]}]}`))
		case r.URL.Path == "/repos/ada/repo/actions/runs/7/rerun-failed-jobs":
			if deny {
				w.WriteHeader(http.StatusForbidden)
				_, _ = w.Write([]byte(`{"message":"Resource not accessible by personal access token"}`))
				return
			}
			w.WriteHeader(http.StatusCreated)
		case r.URL.Path == "/repos/ada/repo/pulls/5/update-branch":
			w.WriteHeader(http.StatusAccepted)
			_, _ = w.Write([]byte(`{"message":"Updating pull request branch."}`))
		default:
			fakeRoutes(w, r)
		}
	})
	if _, err := s.d.Store.DB().Exec(`INSERT INTO session_prs (session_id, url, number, title, last_at) VALUES ('s9', 'https://github.com/ada/repo/pull/5', 5, 'Add x', 1)`); err != nil {
		t.Fatal(err)
	}
	rerun := "/v1/sessions/s9/prs/5/rerun"
	update := "/v1/sessions/s9/prs/5/update-branch"
	if w := call(t, s, machine, "", "POST", rerun, ""); w.Code != http.StatusConflict {
		t.Fatalf("not connected: %d %s", w.Code, w.Body.String())
	}
	call(t, s, machine, "", "POST", "/v1/github/connect", `{"source":"token","token":"ghp_good"}`)
	if w := call(t, s, testPhone, controller, "POST", rerun, ""); w.Code != http.StatusForbidden {
		t.Fatalf("a phone re-ran checks: %d", w.Code)
	}
	if w := call(t, s, machine, "", "POST", "/v1/sessions/s9/prs/6/rerun", ""); w.Code != http.StatusNotFound {
		t.Fatalf("a PR the session did not open: %d %s", w.Code, w.Body.String())
	}
	w := call(t, s, machine, "", "POST", rerun, "")
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"mode":"failed"`) || !strings.Contains(w.Body.String(), `"jobs":1`) {
		t.Fatalf("rerun: %d %s", w.Code, w.Body.String())
	}
	w = call(t, s, machine, "", "POST", update, "")
	if w.Code != http.StatusOK {
		t.Fatalf("update: %d %s", w.Code, w.Body.String())
	}
	mu.Lock()
	got := strings.Join(posted, ",")
	deny, mergeable = true, "false"
	mu.Unlock()
	if !strings.Contains(got, "POST /repos/ada/repo/actions/runs/7/rerun-failed-jobs") || !strings.Contains(got, "PUT /repos/ada/repo/pulls/5/update-branch") {
		t.Fatalf("GitHub was asked: %s", got)
	}
	w = call(t, s, machine, "", "POST", rerun, "")
	if msg, kind := errorOf(t, w); w.Code != http.StatusBadGateway || kind != "scope" || !strings.Contains(w.Body.String(), `\"Actions\" repository permission (write)`) {
		t.Fatalf("refused: %d %s %s", w.Code, msg, w.Body.String())
	}
	// A conflict is not updated from here: the agent resolves it.
	if w := call(t, s, machine, "", "POST", update, ""); w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), "conflicts with main") {
		t.Fatalf("conflict: %d %s", w.Code, w.Body.String())
	}
}
