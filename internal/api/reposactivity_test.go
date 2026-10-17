package api

import (
	"context"
	"encoding/json"
	"net/http"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/store"
)

// The Now screen's Repos section: a row per listed repository with a
// session in it, its local git figures, and GitHub's only from what the deck
// and the PRs & CI tab already read — this route sends GitHub nothing.
func TestReposActivity(t *testing.T) {
	now := time.Now()
	var asked atomic.Int32
	routes := statsRoutes(now)
	s, _, _, repo, _, _ := githubServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/user" {
			asked.Add(1)
		}
		routes(w, r)
	})
	ctx := context.Background()
	for id, cwd := range map[string]string{"s1": repo, "elsewhere": t.TempDir()} {
		if err := store.UpsertSession(ctx, s.d.Store.DB(), id, store.SessionPatch{Cwd: cwd, Agent: "claude", StartedAt: 1000, LastEventAt: now.UnixMilli()}); err != nil {
			t.Fatal(err)
		}
	}
	read := func() ReposActivity {
		t.Helper()
		w := call(t, s, machine, "", "GET", "/v1/repos/activity", "")
		var got ReposActivity
		if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil || w.Code != http.StatusOK {
			t.Fatalf("%d %s", w.Code, w.Body.String())
		}
		return got
	}

	got := read()
	if got.GitHubConnected || len(got.Repos) != 1 {
		t.Fatalf("not connected: %+v", got)
	}
	r := got.Repos[0]
	if r.Sessions != 1 || r.GitHub != nil || len(r.Commits) != 14 || r.Commits[13] < 1 || r.LastCommitAt == 0 || r.Error != "" {
		t.Fatalf("local figures: %+v", r)
	}

	if w := call(t, s, machine, "", "POST", "/v1/github/connect", `{"source":"token","token":"ghp_good"}`); w.Code != http.StatusOK {
		t.Fatalf("connect: %d %s", w.Code, w.Body.String())
	}
	before := asked.Load()
	got = read()
	g := got.Repos[0].GitHub
	if !got.GitHubConnected || g == nil || g.Repo != "ada/repo" || g.Pulls != nil || g.CI != nil || g.Release != nil {
		t.Fatalf("connected, nothing kept yet: %+v", g)
	}
	if asked.Load() != before {
		t.Fatalf("the Repos section asked GitHub %d times", asked.Load()-before)
	}

	// The PRs & CI tab reads the list and the runs; the section then counts them.
	if w := call(t, s, machine, "", "GET", "/v1/sessions/s1/ci/stats", ""); w.Code != http.StatusOK {
		t.Fatalf("stats: %d %s", w.Code, w.Body.String())
	}
	before = asked.Load()
	g = read().Repos[0].GitHub
	if g == nil || g.Pulls == nil || g.Pulls.Open != 1 || g.Pulls.Merged7 != 1 || g.Pulls.Listed != 2 || g.CI == nil || g.CI.Runs != 3 || g.CI.Red != 1 || g.CI.Workflow != "ci" {
		t.Fatalf("kept figures: %+v %+v %+v", g, g.Pulls, g.CI)
	}
	if l := g.CI.Last; l == nil || l.Name != "ci" || l.Branch != "b" || l.Conclusion != "success" || l.At == 0 {
		t.Fatalf("the newest run: %+v", l)
	}
	if asked.Load() != before {
		t.Fatalf("the Repos section asked GitHub %d times", asked.Load()-before)
	}
}
