package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/gitremote"
	"github.com/dspv/caprock/internal/store"
)

// statsRoutes is a GitHub whose repository merged #8 an hour ago (opened 20
// minutes before), has #9 open from another session, and ran ci three times
// today: green, red, and green on a second attempt.
func statsRoutes(now time.Time) http.HandlerFunc {
	ts := func(ago time.Duration) string { return now.Add(-ago).UTC().Format(time.RFC3339) }
	run := func(id int, concl string, attempt int, ago, took time.Duration) string {
		return fmt.Sprintf(`{"id":%d,"workflow_id":1,"name":"ci","event":"pull_request","head_branch":"b","head_sha":"s%d","status":"completed","conclusion":%q,"run_attempt":%d,"created_at":%q,"run_started_at":%q,"updated_at":%q}`,
			id, id, concl, attempt, ts(ago), ts(ago), ts(ago-took))
	}
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer ghp_good" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("X-OAuth-Scopes", "repo")
		switch r.URL.Path {
		case "/user":
			_, _ = w.Write([]byte(`{"login":"ada"}`))
		case "/repos/ada/repo/pulls":
			_, _ = fmt.Fprintf(w, `[{"number":9,"html_url":"https://github.com/ada/repo/pull/9","title":"Open one","state":"open","created_at":%q,"head":{"ref":"feat/nine","sha":"sha9"},"base":{"ref":"main"}},
				{"number":8,"html_url":"https://github.com/ada/repo/pull/8","title":"Merged one","state":"closed","created_at":%q,"merged_at":%q,"head":{"ref":"feat/eight","sha":"sha8"},"base":{"ref":"main"}}]`,
				ts(30*time.Minute), ts(80*time.Minute), ts(time.Hour))
		case "/repos/ada/repo/pulls/9":
			_, _ = fmt.Fprintf(w, `{"number":9,"html_url":"https://github.com/ada/repo/pull/9","title":"Open one","state":"open","created_at":%q,"additions":181,"deletions":59,"changed_files":13,"commits":2,"mergeable":true,"mergeable_state":"clean","head":{"ref":"feat/nine","sha":"sha9"},"base":{"ref":"main"}}`, ts(30*time.Minute))
		case "/repos/ada/repo/actions/runs":
			if r.URL.Query().Get("head_sha") == "sha9" {
				_, _ = w.Write([]byte(`{"workflow_runs":[` + run(91, "success", 1, 20*time.Minute, 6*time.Minute) + `]}`))
				return
			}
			_, _ = w.Write([]byte(`{"workflow_runs":[` + run(3, "success", 1, 40*time.Minute, 6*time.Minute) + `,` + run(2, "failure", 1, 50*time.Minute, 3*time.Minute) + `,` + run(1, "success", 2, 60*time.Minute, 8*time.Minute) + `]}`))
		case "/repos/ada/repo/actions/runs/91/jobs":
			_, _ = w.Write([]byte(`{"jobs":[]}`))
		default:
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"message":"Not Found"}`))
		}
	}
}

// The PRs & CI tab's answer: nothing while GitHub is not connected; then the
// repository's pull requests and the figures counted from them and its runs.
// A pull request of the repository that is not the session's is read (its CI,
// its diff size) only once the tab has listed it.
func TestSessionCIStats(t *testing.T) {
	now := time.Now()
	s, _, _, _, _, _ := githubServer(t, statsRoutes(now))
	ctx := context.Background()
	if err := store.UpsertSession(ctx, s.d.Store.DB(), "s1", store.SessionPatch{Cwd: "/work/repo", Agent: "claude", StartedAt: 1000, LastEventAt: 2000}); err != nil {
		t.Fatal(err)
	}
	s.repos.lookup = func(_ context.Context, dir string) (gitremote.Repo, bool) {
		return gitremote.Repo{Root: dir, URL: "https://github.com/ada/repo"}, true
	}
	read := func() SessionCIStats {
		t.Helper()
		w := call(t, s, machine, "", "GET", "/v1/sessions/s1/ci/stats", "")
		var got SessionCIStats
		if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil || w.Code != http.StatusOK {
			t.Fatalf("%d %s", w.Code, w.Body.String())
		}
		return got
	}
	if got := read(); got.Connected || got.Repo != "ada/repo" || got.Stats != nil || len(got.PRs) != 0 {
		t.Fatalf("not connected: %+v", got)
	}
	// Not listed yet: #8 is not this session's, so it is not read.
	if w := call(t, s, machine, "", "POST", "/v1/github/connect", `{"source":"token","token":"ghp_good"}`); w.Code != http.StatusOK {
		t.Fatalf("connect: %d %s", w.Code, w.Body.String())
	}
	if w := call(t, s, machine, "", "GET", "/v1/sessions/s1/ci?pr=8", ""); w.Code != http.StatusOK || strings.Contains(w.Body.String(), `"number":8`) {
		t.Fatalf("#8 read before the tab listed it: %d %s", w.Code, w.Body.String())
	}
	got := read()
	if !got.Connected || len(got.PRs) != 2 || got.PRs[0].Number != 9 || got.PRs[1].MergedAt == 0 || got.PRs[1].CreatedAt == 0 || got.Stats == nil {
		t.Fatalf("connected: %+v", got)
	}
	st := got.Stats
	merged := 0
	for _, n := range st.Merged {
		merged += n
	}
	if len(st.Days) != 14 || len(st.Merged) != 14 || merged != 1 || st.TTMCount != 1 || st.TTMMedianMS != 0 {
		t.Fatalf("merges: %+v", st)
	}
	if st.CI.Runs != 3 || st.CI.Red != 1 || st.CI.Reruns != 1 || len(st.CI.Workflows) != 1 || st.CI.Workflows[0].MedianMS != 7*60_000 {
		t.Fatalf("ci: %+v", st.CI)
	}
	// Listed now: #9's CI and its size are read.
	w := call(t, s, machine, "", "GET", "/v1/sessions/s1/ci?pr=9", "")
	var ci SessionCI
	if err := json.Unmarshal(w.Body.Bytes(), &ci); err != nil || ci.PR == nil || ci.PR.Number != 9 || ci.PR.Live == nil || ci.PR.Live.Additions == nil || *ci.PR.Live.Additions != 181 || *ci.PR.Live.ChangedFiles != 13 || ci.CI == nil {
		t.Fatalf("#9: %d %s", w.Code, w.Body.String())
	}
	// A number nobody listed stays out of reach of the force actions.
	if w := call(t, s, machine, "", "POST", "/v1/sessions/s1/prs/77/rerun", ""); w.Code != http.StatusNotFound {
		t.Fatalf("rerun #77: %d %s", w.Code, w.Body.String())
	}
}
