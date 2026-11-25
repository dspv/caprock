package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
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
		// githubstatus.com, which is sent no token.
		if r.URL.Path == "/status" {
			if r.Header.Get("Authorization") != "" {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			_, _ = w.Write([]byte(`{"status":{"indicator":"minor","description":"Partially Degraded Service"},"components":[{"name":"Actions","status":"degraded_performance"},{"name":"Pages","status":"operational"},{"name":"API Requests","status":"operational"},{"name":"Visit www.githubstatus.com","status":"operational","group":true}],"incidents":[{"name":"Delayed Actions runs","status":"investigating","impact":"minor","shortlink":"https://stspg.io/x"},{"name":"Old","status":"resolved"}]}`))
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
		case "/repos/ada/repo/pulls":
			_, _ = fmt.Fprintf(w, `[{"number":9,"html_url":"https://github.com/ada/repo/pull/9","title":"Open one","state":"open","created_at":%q,"user":{"login":"grace","avatar_url":"https://avatars.githubusercontent.com/u/2"},"head":{"ref":"feat/nine","sha":"sha9"},"base":{"ref":"main"}},
				{"number":8,"html_url":"https://github.com/ada/repo/pull/8","title":"Merged one","state":"closed","created_at":%q,"merged_at":%q,"user":{"login":"ada","avatar_url":"https://avatars.githubusercontent.com/u/1"},"head":{"ref":"feat/eight","sha":"sha8"},"base":{"ref":"main"}}]`,
				ts(30*time.Minute), ts(80*time.Minute), ts(time.Hour))
		case "/repos/ada/repo/pulls/9":
			_, _ = fmt.Fprintf(w, `{"number":9,"html_url":"https://github.com/ada/repo/pull/9","title":"Open one","state":"open","created_at":%q,"additions":181,"deletions":59,"changed_files":13,"commits":2,"mergeable":true,"mergeable_state":"clean","head":{"ref":"feat/nine","sha":"sha9"},"base":{"ref":"main"}}`, ts(30*time.Minute))
		case "/repos/ada/repo/actions/runs":
			if r.URL.Query().Get("head_sha") == "sha9" {
				_, _ = w.Write([]byte(`{"workflow_runs":[` + run(91, "success", 1, 20*time.Minute, 6*time.Minute) + `]}`))
				return
			}
			_, _ = w.Write([]byte(`{"workflow_runs":[` + run(3, "success", 1, 40*time.Minute, 6*time.Minute) + `,` + run(2, "failure", 1, 50*time.Minute, 3*time.Minute) + `,` + run(1, "success", 2, 60*time.Minute, 8*time.Minute) + `]}`))
		case "/repos/ada/repo/releases":
			_, _ = fmt.Fprintf(w, `[{"tag_name":"v1.1.0","name":"v1.1.0","html_url":"https://github.com/ada/repo/releases/tag/v1.1.0","published_at":%q},{"tag_name":"v1.2.0-draft","draft":true},{"tag_name":"v1.0.0","html_url":"https://github.com/ada/repo/releases/tag/v1.0.0","published_at":%q}]`, ts(30*time.Minute), ts(48*time.Hour))
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
	// The board: #9 open with its author, #8 merged an hour ago and shipped in
	// v1.1.0, published since; the draft release is left out.
	if got.PRs[0].Author != "grace" || got.PRs[0].AuthorAvatar == "" || got.PRs[0].Head != "feat/nine" {
		t.Fatalf("author: %+v", got.PRs[0])
	}
	b := got.Board
	if b == nil || len(b.Cards) != 2 {
		t.Fatalf("board: %+v", b)
	}
	stage := map[int]BoardCard{}
	for _, c := range b.Cards {
		stage[c.Number] = c
	}
	if c := stage[8]; c.Stage != StageReleased || c.Release != "v1.1.0" || c.StageAt == 0 {
		t.Fatalf("#8: %+v", c)
	}
	if c := stage[9]; c.Stage == StageMerged || c.Stage == StageReleased || c.Spend.Agents == nil {
		t.Fatalf("#9: %+v", c)
	}
	if len(b.Releases) != 2 || b.Releases[0].Tag != "v1.1.0" || len(b.Releases[0].PRs) != 1 || b.Releases[0].PRs[0] != 8 || len(b.Releases[1].PRs) != 0 {
		t.Fatalf("releases: %+v", b.Releases)
	}
	if b.Flow.Merged != 1 || b.Flow.Counts[StageReleased] != 1 || b.Flow.ReleaseLagCount != 1 || b.Flow.ReleaseLagMedianMS != 0 {
		t.Fatalf("flow: %+v", b.Flow)
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

// ?fresh=1 reads the pull request list again at once, so a pull request just
// opened is listed without waiting out the list's two minutes (#1078 sat in
// the session's own list while the PRs view read a list from before it); a
// second forced read seconds later asks GitHub nothing, and a plain read
// never forces one.
func TestSessionCIStatsFresh(t *testing.T) {
	start := time.Now()
	inner := statsRoutes(start)
	var lists atomic.Int32
	var opened atomic.Bool
	route := func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/repos/ada/repo/pulls" {
			inner(w, r)
			return
		}
		lists.Add(1)
		rec := httptest.NewRecorder()
		inner(rec, r)
		body := rec.Body.String()
		if opened.Load() {
			body = `[{"number":10,"html_url":"https://github.com/ada/repo/pull/10","title":"Just opened","state":"open","created_at":"` +
				start.UTC().Format(time.RFC3339) + `","head":{"ref":"feat/ten","sha":"sha10"},"base":{"ref":"main"}},` + strings.TrimPrefix(strings.TrimSpace(body), "[")
		}
		for k, v := range rec.Header() {
			w.Header()[k] = v
		}
		w.WriteHeader(rec.Code)
		_, _ = w.Write([]byte(body))
	}
	s, _, _, _, _, _ := githubServer(t, route)
	var clock atomic.Int64
	clock.Store(start.UnixMilli())
	now := func() time.Time { return time.UnixMilli(clock.Load()) }
	s.d.GitHub.Now = now
	s.deck = newDeckCache(now)
	ctx := context.Background()
	if err := store.UpsertSession(ctx, s.d.Store.DB(), "s1", store.SessionPatch{Cwd: "/work/repo", Agent: "claude", StartedAt: 1000, LastEventAt: 2000}); err != nil {
		t.Fatal(err)
	}
	s.repos.lookup = func(_ context.Context, dir string) (gitremote.Repo, bool) {
		return gitremote.Repo{Root: dir, URL: "https://github.com/ada/repo"}, true
	}
	if w := call(t, s, machine, "", "POST", "/v1/github/connect", `{"source":"token","token":"ghp_good"}`); w.Code != http.StatusOK {
		t.Fatalf("connect: %d %s", w.Code, w.Body.String())
	}
	read := func(q string) SessionCIStats {
		t.Helper()
		w := call(t, s, machine, "", "GET", "/v1/sessions/s1/ci/stats"+q, "")
		var got SessionCIStats
		if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil || w.Code != http.StatusOK {
			t.Fatalf("%d %s", w.Code, w.Body.String())
		}
		s.deck.wait()
		return got
	}
	has := func(a SessionCIStats, n int) bool {
		for _, p := range a.PRs {
			if p.Number == n {
				return true
			}
		}
		return false
	}
	if got := read(""); !got.Connected || has(got, 10) || lists.Load() != 1 {
		t.Fatalf("first: %d lists %+v", lists.Load(), got.PRs)
	}
	// #10 is opened; a plain read past the deck's two seconds is answered
	// from the list kept two minutes: no new read, #10 missing.
	opened.Store(true)
	clock.Add((5 * time.Second).Milliseconds())
	read("")
	if got := read(""); has(got, 10) || lists.Load() != 1 {
		t.Fatalf("plain read: %d lists %+v", lists.Load(), got.PRs)
	}
	// Forced: the list is read again and #10 is in the answer.
	if got := read("?fresh=1"); !has(got, 10) || lists.Load() != 2 {
		t.Fatalf("fresh: %d lists %+v", lists.Load(), got.PRs)
	}
	// Forced again a second later: composed anew, GitHub not asked.
	clock.Add(time.Second.Milliseconds())
	if got := read("?fresh=1"); !has(got, 10) || lists.Load() != 2 {
		t.Fatalf("fresh again: %d lists %+v", lists.Load(), got.PRs)
	}
}
