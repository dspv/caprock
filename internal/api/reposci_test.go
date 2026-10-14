package api

import (
	"context"
	"encoding/json"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
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

// Only repositories with activity in the last 14 days are read, most recent
// first; older ones and those this viewer hid are listed quietly and never
// asked of GitHub until older ones are asked. A repository GitHub does not
// answer in time is said so on its own row, and does not hold up the rest
// (owner, 2026-10-14: a wall of "context deadline exceeded" on repositories
// untouched for ages).
func TestReposCIRecentHiddenSlow(t *testing.T) {
	now := time.Now()
	var mu sync.Mutex
	asked := map[string]int{}
	inner := statsRoutes(now)
	s, _, _, repo, _, _ := githubServer(t, func(w http.ResponseWriter, r *http.Request) {
		for _, n := range []string{"old", "hid", "slow"} {
			if strings.HasPrefix(r.URL.Path, "/repos/ada/"+n+"/") {
				mu.Lock()
				asked[n]++
				mu.Unlock()
				if n == "slow" {
					select {
					case <-r.Context().Done():
					case <-time.After(3 * time.Second):
					}
					return
				}
				_, _ = w.Write([]byte(`[]`))
				return
			}
		}
		inner(w, r)
	})
	old := reposCIRepoTimeout
	reposCIRepoTimeout = 300 * time.Millisecond
	t.Cleanup(func() { reposCIRepoTimeout = old })
	s.deck.budget = 10 * time.Second
	ctx := context.Background()
	db := s.d.Store.DB()
	if err := store.UpsertSession(ctx, db, "s1", store.SessionPatch{Cwd: repo, Agent: "claude", StartedAt: 1000, LastEventAt: now.UnixMilli()}); err != nil {
		t.Fatal(err)
	}
	month := now.AddDate(0, 0, -40).UnixMilli()
	for _, p := range []struct {
		name  string
		added int64
	}{{"old", month}, {"hid", now.UnixMilli()}, {"slow", now.Add(-time.Hour).UnixMilli()}} {
		if _, err := db.ExecContext(ctx, `INSERT INTO projects(root, name, kind, source, remote_url, added_at) VALUES(?,?,'repo','seed',?,?)`,
			filepath.Join(t.TempDir(), p.name), p.name, "https://github.com/ada/"+p.name+".git", p.added); err != nil {
			t.Fatal(err)
		}
	}
	if w := call(t, s, machine, "", "POST", "/v1/github/connect", `{"source":"token","token":"ghp_good"}`); w.Code != http.StatusOK {
		t.Fatalf("connect: %d %s", w.Code, w.Body.String())
	}
	read := func(q string) ReposCI {
		t.Helper()
		w := call(t, s, machine, "", "GET", "/v1/repos/ci"+q, "")
		var got ReposCI
		if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil || w.Code != http.StatusOK {
			t.Fatalf("%d %s", w.Code, w.Body.String())
		}
		return got
	}
	names := func(rs []RepoCIRow) (out []string) {
		for _, r := range rs {
			out = append(out, r.Repo)
		}
		return out
	}
	got := read("?hide=ADA/hid")
	// The running one first, then the newest activity.
	if n := names(got.Repos); len(n) != 2 || n[0] != "ada/repo" || n[1] != "ada/slow" || got.RecentDays != 14 {
		t.Fatalf("rows: %v", n)
	}
	if !got.Repos[1].Slow || got.Repos[1].Error == nil || got.Repos[0].Slow || got.Repos[0].Error != nil || got.Repos[0].CI == nil {
		t.Fatalf("slow: %+v / %+v", got.Repos[1], got.Repos[0])
	}
	if len(got.Quiet) != 2 || got.Quiet[0].Repo != "ada/hid" || got.Quiet[0].Why != "hidden" || got.Quiet[1].Repo != "ada/old" || got.Quiet[1].Why != "older" || got.Quiet[1].LastActive != month {
		t.Fatalf("quiet: %+v", got.Quiet)
	}
	mu.Lock()
	if asked["old"] != 0 || asked["hid"] != 0 {
		t.Fatalf("asked GitHub for a quiet one: %v", asked)
	}
	mu.Unlock()
	// Shown: the older one is read too, marked; the hidden one still not.
	got = read("?older=1&hide=ada/hid")
	if n := names(got.Repos); len(n) != 3 || n[2] != "ada/old" || !got.Repos[2].Older || len(got.Quiet) != 1 || got.Quiet[0].Why != "hidden" {
		t.Fatalf("older: %v %+v", n, got.Quiet)
	}
	mu.Lock()
	defer mu.Unlock()
	if asked["old"] == 0 || asked["hid"] != 0 {
		t.Fatalf("asked: %v", asked)
	}
}
