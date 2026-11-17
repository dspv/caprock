package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/dspv/caprock/internal/gitremote"
	"github.com/dspv/caprock/internal/store"
)

// branchPRRoutes is a GitHub where #15 (feat/old) is merged and #17
// (feat/new), opened by a script, is open; a pull request whose head is main
// stands for a push to the default branch. listDown fails the list.
func branchPRRoutes(lists *atomic.Int32, listDown *atomic.Bool) http.HandlerFunc {
	pull := func(n int, head, state, merged string) string {
		return `{"number":` + strconv.Itoa(n) + `,"html_url":"https://github.com/ada/repo/pull/` + strconv.Itoa(n) + `","title":"PR ` + strconv.Itoa(n) +
			`","state":"` + state + `"` + merged + `,"head":{"ref":"` + head + `","sha":"sha` + strconv.Itoa(n) + `"},"base":{"ref":"main"}}`
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
			lists.Add(1)
			if listDown.Load() {
				w.WriteHeader(http.StatusBadGateway)
				_, _ = w.Write([]byte(`{"message":"Server Error"}`))
				return
			}
			_, _ = w.Write([]byte(`[` + pull(17, "feat/new", "open", "") + `,` + pull(15, "feat/old", "closed", `,"merged_at":"2026-11-17T09:00:00Z"`) + `,` +
				pull(12, "main", "closed", "") + `]`))
		case "/repos/ada/repo/pulls/15":
			_, _ = w.Write([]byte(pull(15, "feat/old", "closed", `,"merged_at":"2026-11-17T09:00:00Z"`)))
		case "/repos/ada/repo/pulls/17":
			_, _ = w.Write([]byte(pull(17, "feat/new", "open", "")))
		case "/repos/ada/repo/actions/runs":
			_, _ = w.Write([]byte(`{"workflow_runs":[]}`))
		default:
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"message":"Not Found"}`))
		}
	}
}

// A session that recorded #15 with `gh pr merge` and then pushed feat/new,
// whose pull request #17 a script opened: the PRs cell lists #17 first and
// the CI cell shows #17, not the merged #15. The push to main finds nothing;
// without GitHub, or when GitHub fails, the recorded #15 alone is the answer.
func TestSessionPRsFoundByPushedBranch(t *testing.T) {
	var lists atomic.Int32
	var listDown atomic.Bool
	s, _, _, _, _, _ := githubServer(t, branchPRRoutes(&lists, &listDown))
	ctx := context.Background()
	db := s.d.Store.DB()
	if err := store.UpsertSession(ctx, db, "s1", store.SessionPatch{Cwd: "/work/repo", Agent: "claude", StartedAt: 1000, LastEventAt: 9000}); err != nil {
		t.Fatal(err)
	}
	s.repos.lookup = func(_ context.Context, dir string) (gitremote.Repo, bool) {
		return gitremote.Repo{Root: dir, URL: "https://github.com/ada/repo", DefaultBranch: "main"}, true
	}
	if err := store.RecordPR(ctx, db, store.PRAction{SessionID: "s1", URL: "https://github.com/ada/repo/pull/15", Number: 15, Title: "Old", Action: "merged", Ts: 2000}); err != nil {
		t.Fatal(err)
	}
	for _, p := range []struct {
		branch string
		ts     int64
	}{{"feat/old", 1500}, {"feat/new", 5000}, {"main", 6000}} {
		if err := store.RecordPush(ctx, db, "s1", p.branch, p.ts); err != nil {
			t.Fatal(err)
		}
	}
	prsOf := func() SessionPRs {
		t.Helper()
		w := call(t, s, machine, "", "GET", "/v1/sessions/s1/prs", "")
		var got SessionPRs
		if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil || w.Code != http.StatusOK {
			t.Fatalf("%d %s", w.Code, w.Body.String())
		}
		return got
	}
	if got := prsOf(); got.Connected || len(got.PRs) != 1 || got.PRs[0].Number != 15 || lists.Load() != 0 {
		t.Fatalf("not connected: %+v, %d lists", got, lists.Load())
	}
	if w := call(t, s, machine, "", "POST", "/v1/github/connect", `{"source":"token","token":"ghp_good"}`); w.Code != http.StatusOK {
		t.Fatalf("connect: %d %s", w.Code, w.Body.String())
	}

	// GitHub failing, no list kept yet: the recorded pull request alone.
	listDown.Store(true)
	if list, err := s.sessionPRList(ctx, "s1"); err != nil || len(list) != 1 || list[0].Number != 15 {
		t.Fatalf("GitHub down: %+v %v", list, err)
	}
	listDown.Store(false)
	lists.Store(0)

	got := prsOf()
	if len(got.PRs) != 2 || got.PRs[0].Number != 17 || got.PRs[0].LastAt != 5000 || got.PRs[0].Title != "PR 17" ||
		got.PRs[1].Number != 15 || got.PRs[1].Title != "Old" || got.PRs[1].MergedAt != 2000 || got.PRs[1].LastAt != 2000 {
		t.Fatalf("connected: %+v", got.PRs)
	}
	if got.PRs[0].Live == nil || got.PRs[0].Live.State != "open" {
		t.Fatalf("#17 not read live: %+v", got.PRs[0])
	}
	w := call(t, s, machine, "", "GET", "/v1/sessions/s1/ci", "")
	var ci SessionCI
	if err := json.Unmarshal(w.Body.Bytes(), &ci); err != nil || w.Code != http.StatusOK {
		t.Fatalf("ci: %d %s", w.Code, w.Body.String())
	}
	if ci.PR == nil || ci.PR.Number != 17 || ci.PR.State != "open" {
		t.Fatalf("ci picked %+v", ci.PR)
	}
	// One kept list of the repository answers every branch, both cells.
	if n := lists.Load(); n != 1 {
		t.Errorf("listed the pull requests %d times, want 1", n)
	}
	// The force actions act on the pull request found by its branch.
	if w := call(t, s, machine, "", "POST", "/v1/sessions/s1/prs/17/update-branch", ""); strings.Contains(w.Body.String(), "neither this session's pull request") {
		t.Fatalf("update-branch #17: %d %s", w.Code, w.Body.String())
	}
}
