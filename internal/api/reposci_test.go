package api

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/store"
)

// The Now screen's CI/CD section: nothing while GitHub is not connected;
// then each listed repository's runs, its pull requests with what the agents
// recorded on them cost, who opened them, its newest release, and GitHub's
// status page — read without the token.
func TestReposCI(t *testing.T) {
	now := time.Now()
	s, _, _, repo, _, _ := githubServer(t, statsRoutes(now))
	s.d.GitHub.StatusURL = s.d.GitHub.API + "/status"
	ctx := context.Background()
	if err := store.UpsertSession(ctx, s.d.Store.DB(), "s1", store.SessionPatch{Cwd: repo, Agent: "claude", GitBranch: "feat/nine", StartedAt: 1000, LastEventAt: now.UnixMilli()}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.d.Store.DB().ExecContext(ctx, `INSERT INTO session_stats(session_id, cost_usd) VALUES('s1', 2.5)`); err != nil {
		t.Fatal(err)
	}
	read := func() ReposCI {
		t.Helper()
		w := call(t, s, machine, "", "GET", "/v1/repos/ci", "")
		var got ReposCI
		if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil || w.Code != http.StatusOK {
			t.Fatalf("%d %s", w.Code, w.Body.String())
		}
		return got
	}
	if got := read(); got.GitHubConnected || len(got.Repos) != 0 || got.Status != nil {
		t.Fatalf("not connected: %+v", got)
	}
	if w := call(t, s, machine, "", "POST", "/v1/github/connect", `{"source":"token","token":"ghp_good"}`); w.Code != http.StatusOK {
		t.Fatalf("connect: %d %s", w.Code, w.Body.String())
	}
	got := read()
	if !got.GitHubConnected || got.Status == nil || got.Status.Indicator != "minor" || got.Status.Error != "" {
		t.Fatalf("status: %+v", got.Status)
	}
	// Actions is degraded; API Requests is watched; Pages is fine and left out.
	if len(got.Status.Components) != 2 || got.Status.Components[0].Name != "Actions" || len(got.Status.Incidents) != 1 {
		t.Fatalf("status parts: %+v", got.Status)
	}
	if len(got.Repos) != 1 {
		t.Fatalf("repos: %+v", got.Repos)
	}
	r := got.Repos[0]
	if r.Repo != "ada/repo" || r.Live != 1 || r.CI == nil || r.CI.Runs != 3 || r.CI.Red != 1 || len(r.Days) != 14 || r.Open != 1 || r.Merged7 != 1 || r.Error != nil {
		t.Fatalf("row: %+v", r)
	}
	if r.Release == nil || r.Release.Tag != "v1.1.0" {
		t.Fatalf("release: %+v", r.Release)
	}
	// #9's branch is the session's: its cost is #9's, and grace's.
	if len(r.TopPRs) != 1 || r.TopPRs[0].Number != 9 || r.TopPRs[0].CostUSD != 2.5 || r.TopPRs[0].Live != 1 || r.TopPRs[0].Author != "grace" {
		t.Fatalf("top: %+v", r.TopPRs)
	}
	if len(r.Authors) != 2 || r.Authors[0].Login != "grace" || r.Authors[0].CostUSD != 2.5 || r.Authors[1].Login != "ada" || r.Authors[1].Merged != 1 {
		t.Fatalf("authors: %+v", r.Authors)
	}
}
