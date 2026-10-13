package api

import (
	"context"
	"net/http"
	"time"

	"github.com/dspv/caprock/internal/github"
	"github.com/dspv/caprock/internal/store"
)

// SessionCIStats is GET /v1/sessions/{id}/ci/stats: the figures and the
// pull request list of the PRs & CI tab (.ai/21-app.md § PRs & CI tab), for
// the repository of the session's working directory.
type SessionCIStats struct {
	Connected bool `json:"connected"`
	// Repo and Reason: as SessionRepoCI says them.
	Repo   string `json:"repo,omitempty"`
	Reason string `json:"reason,omitempty"`
	// PRs is the repository's own pull requests, most recently updated
	// first, from the list the Branches view reads (its newest 50).
	PRs   []github.BranchPR `json:"prs"`
	Stats *github.RepoStats `json:"stats,omitempty"`
	Error *github.Error     `json:"error,omitempty"`
	// FetchedAt and Refreshing: as SessionPRs says them.
	FetchedAt  int64 `json:"fetched_at"`
	Refreshing bool  `json:"refreshing,omitempty"`
}

func (a SessionCIStats) stamped(at int64, refreshing bool) any {
	a.FetchedAt, a.Refreshing = at, refreshing
	return a
}

// handleSessionCIStats answers the PRs & CI tab, which asks only while it is
// shown: the repository's pull request list (one read shared with the
// Branches view, kept 2 minutes) and its newest 100 runs (one read, kept 30
// minutes), counted into the tab's figures. Nothing is sent while GitHub is
// not connected (rule 4). The composed answer is kept (deckcache.go).
func (s *Server) handleSessionCIStats(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	connected := s.githubConnected()
	s.serveDeck(w, r, deckKey("stats", id, connected, 0), func(ctx context.Context) (deckAnswer, error) {
		return s.composeSessionCIStats(ctx, id, connected)
	}, s.notFoundOrFail)
}

func (s *Server) composeSessionCIStats(ctx context.Context, id string, connected bool) (deckAnswer, error) {
	var where SessionRepoCI
	repo, _, ok, err := s.sessionRepo(ctx, id, &where)
	if err != nil {
		return nil, err
	}
	out := SessionCIStats{Connected: connected, Repo: where.Repo, Reason: where.Reason, PRs: []github.BranchPR{}}
	if !ok || !connected {
		return out, nil
	}
	prs, e := s.d.GitHub.RepoPulls(ctx, repo)
	if e != nil {
		out.Error = e
		return out, nil
	}
	out.PRs = prs
	runs, e := s.d.GitHub.RepoRuns(ctx, repo)
	if e != nil {
		// The pull requests are still worth showing; the runs' figures wait.
		out.Error = e
	}
	now := time.Now()
	if s.d.GitHub.Now != nil {
		now = s.d.GitHub.Now()
	}
	st := github.Stats(prs, runs, now, github.StatsDays)
	out.Stats = &st
	return out, nil
}

// repoPRURL is the link of pull request n of the session's repository when
// the PRs & CI tab listed it: from the last list read (github.CachedRepoPull),
// so nothing is sent and no number a request merely names is acted on.
func (s *Server) repoPRURL(ctx context.Context, id string, n int) (string, bool) {
	if n <= 0 || s.d.GitHub == nil {
		return "", false
	}
	var where SessionRepoCI
	repo, _, ok, err := s.sessionRepo(ctx, id, &where)
	if err != nil || !ok {
		return "", false
	}
	p, ok := s.d.GitHub.CachedRepoPull(repo, n)
	if !ok || p.URL == "" {
		return "", false
	}
	return p.URL, true
}

// hasPR says whether the session recorded pull request n.
func hasPR(prs []store.SessionPR, n int) bool {
	for _, p := range prs {
		if p.Number == n {
			return true
		}
	}
	return false
}
