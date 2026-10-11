package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/dspv/caprock/internal/gitremote"
	"github.com/dspv/caprock/internal/store"
)

// repoCIRoutes is a GitHub where tag v1.2.0's release run is under way, past
// release runs took 10 and 14 min, and main's CI failed.
func repoCIRoutes(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Authorization") != "Bearer ghp_good" {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	w.Header().Set("X-OAuth-Scopes", "repo")
	run := func(id, wf int, name, branch, status, concl, start, end string) string {
		return fmt.Sprintf(`{"id":%d,"workflow_id":%d,"name":%q,"event":"push","head_branch":%q,"head_sha":"s%d","status":%q,"conclusion":%q,"run_attempt":1,"created_at":%q,"run_started_at":%q,"updated_at":%q}`,
			id, wf, name, branch, id, status, concl, start, start, end)
	}
	mainRun := run(29, 1, "CI", "main", "completed", "failure", "2026-10-11T09:50:00Z", "2026-10-11T09:59:00Z")
	switch r.URL.Path {
	case "/user":
		_, _ = w.Write([]byte(`{"login":"ada"}`))
	case "/repos/ada/repo":
		_, _ = w.Write([]byte(`{"full_name":"ada/repo","default_branch":"main"}`))
	case "/repos/ada/repo/actions/runs":
		q := r.URL.Query()
		switch {
		case q.Get("event") == "push":
			_, _ = w.Write([]byte(`{"workflow_runs":[` + run(30, 9, "Release", "v1.2.0", "in_progress", "", "2026-10-11T10:00:00Z", "2026-10-11T10:02:00Z") + `,` + mainRun + `]}`))
		case q.Get("branch") == "main":
			_, _ = w.Write([]byte(`{"workflow_runs":[` + mainRun + `]}`))
		default:
			_, _ = w.Write([]byte(`{"workflow_runs":[]}`))
		}
	case "/repos/ada/repo/actions/workflows/9/runs":
		_, _ = w.Write([]byte(`{"workflow_runs":[` + run(20, 9, "Release", "v1.1.0", "completed", "success", "2026-10-10T10:00:00Z", "2026-10-10T10:10:00Z") + `,` +
			run(19, 9, "Release", "v1.0.0", "completed", "success", "2026-10-09T10:00:00Z", "2026-10-09T10:14:00Z") + `]}`))
	case "/repos/ada/repo/actions/runs/30/jobs":
		_, _ = w.Write([]byte(`{"jobs":[{"id":301,"run_id":30,"name":"goreleaser","status":"in_progress","started_at":"2026-10-11T10:00:10Z","labels":["ubuntu-latest"],"steps":[]}]}`))
	case "/repos/ada/repo/actions/runs/29/jobs":
		_, _ = w.Write([]byte(`{"jobs":[{"id":291,"run_id":29,"name":"test","status":"completed","conclusion":"failure","started_at":"2026-10-11T09:50:00Z","completed_at":"2026-10-11T09:59:00Z","labels":["windows-latest"],"steps":[]}]}`))
	default:
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"message":"Not Found"}`))
	}
}

// The Release and Main views read the session's repository from its working
// directory: nothing while GitHub is not connected, a reason when there is no
// GitHub repository, else the release run with its estimate and main's CI.
// A job's log is read only in the view that lists it.
func TestSessionCIReleaseAndMain(t *testing.T) {
	s, _, _, _, _, _ := githubServer(t, repoCIRoutes)
	ctx := context.Background()
	for id, dir := range map[string]string{"s1": "/work/repo", "s2": "/work/plain", "s3": "/work/gitlab"} {
		if err := store.UpsertSession(ctx, s.d.Store.DB(), id, store.SessionPatch{Cwd: dir, Agent: "claude", StartedAt: 1000, LastEventAt: 2000}); err != nil {
			t.Fatal(err)
		}
	}
	s.repos.lookup = func(_ context.Context, dir string) (gitremote.Repo, bool) {
		switch dir {
		case "/work/repo":
			return gitremote.Repo{Root: dir, URL: "https://github.com/ada/repo"}, true
		case "/work/gitlab":
			return gitremote.Repo{Root: dir, URL: "https://gitlab.com/ada/repo"}, true
		}
		return gitremote.Repo{Root: dir}, false
	}
	read := func(path string) SessionRepoCI {
		t.Helper()
		w := call(t, s, machine, "", "GET", path, "")
		var got SessionRepoCI
		if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil || w.Code != http.StatusOK {
			t.Fatalf("%s: %d %s", path, w.Code, w.Body.String())
		}
		return got
	}
	if got := read("/v1/sessions/s1/ci/release"); got.Connected || got.Repo != "ada/repo" || got.Release != nil {
		t.Fatalf("not connected: %+v", got)
	}
	if w := call(t, s, machine, "", "POST", "/v1/github/connect", `{"source":"token","token":"ghp_good"}`); w.Code != http.StatusOK {
		t.Fatalf("connect: %d %s", w.Code, w.Body.String())
	}
	if got := read("/v1/sessions/s2/ci/release"); got.Reason != "no_repo" || got.Release != nil {
		t.Fatalf("no repo: %+v", got)
	}
	if got := read("/v1/sessions/s3/ci/main"); got.Reason != "not_github" || got.CI != nil {
		t.Fatalf("not github: %+v", got)
	}
	got := read("/v1/sessions/s1/ci/release")
	if got.Release == nil || got.Release.Tag != "v1.2.0" || got.Release.State != "running" || got.Release.Estimate == nil || got.Release.Estimate.MedianMS != 12*60_000 || got.Release.Estimate.Runs != 2 {
		t.Fatalf("release: %+v %+v", got, got.Release)
	}
	got = read("/v1/sessions/s1/ci/main")
	if got.Branch != "main" || got.CI == nil || got.CI.State != "fail" || len(got.CI.Runs) != 1 || got.CI.Runs[0].Jobs[0].ID != 291 {
		t.Fatalf("main: %+v", got)
	}
	if w := call(t, s, machine, "", "GET", "/v1/sessions/s1/ci/jobs/291/log?view=release", ""); w.Code != http.StatusNotFound {
		t.Fatalf("main's job read as release's: %d %s", w.Code, w.Body.String())
	}
	if w := call(t, s, machine, "", "GET", "/v1/sessions/s1/ci/jobs/291/log", ""); w.Code != http.StatusNotFound {
		t.Fatalf("main's job read as the PR's: %d %s", w.Code, w.Body.String())
	}
	if w := call(t, s, machine, "", "GET", "/v1/sessions/nobody/ci/release", ""); w.Code != http.StatusNotFound {
		t.Fatalf("no session: %d %s", w.Code, w.Body.String())
	}
}
