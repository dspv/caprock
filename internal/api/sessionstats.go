package api

import (
	"context"
	"net/http"
	"strconv"
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
	// Board is the Board view: the pull requests by stage, the releases and
	// the flow strip (prboard.go).
	Board *PRBoard `json:"board,omitempty"`
	// Error is GitHub's refusal of the newest read: with PRs present, those
	// are the ones read at ReadAt, not refreshed.
	Error *github.Error `json:"error,omitempty"`
	// ReadAt is when GitHub last answered what the board draws on — the
	// older of the pull request list's and the releases' reads (unix ms; 0
	// when not read). FetchedAt says when the answer was put together,
	// which can be later: a composition that could not reach GitHub draws on
	// what it last read.
	ReadAt int64 `json:"read_at,omitempty"`
	deckFresh
}

func (a SessionCIStats) stamped(f deckFresh) any {
	a.deckFresh = f
	return a
}

// statsGitHubBudget bounds the GitHub reads of one PRs & CI composition;
// statsComposeTimeout the composition, so the store's reads after them
// always have time left. Past the budget the answer draws on what was last
// read, its cards marked stale, instead of failing whole: a composition that
// failed on every refresh froze the board on its last answer for hours
// behind a bare "updating…" (owner, 2026-10-14).
var statsGitHubBudget = 10 * time.Second // a variable for the tests

const statsComposeTimeout = 20 * time.Second

// handleSessionCIStats answers the PRs & CI tab, which asks only while it is
// shown: the repository's pull request list (one read shared with the
// Branches view, kept 2 minutes) and its newest 100 runs (one read, kept 30
// minutes), counted into the tab's figures. Nothing is sent while GitHub is
// not connected (rule 4). The composed answer is kept (deckcache.go).
func (s *Server) handleSessionCIStats(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	connected := s.githubConnected()
	s.serveDeckWithin(w, r, deckKey("stats", id, connected, 0), statsComposeTimeout, func(ctx context.Context) (deckAnswer, error) {
		return s.composeSessionCIStats(ctx, id, connected)
	}, s.notFoundOrFail)
}

func (s *Server) composeSessionCIStats(ctx context.Context, id string, connected bool) (deckAnswer, error) {
	var where SessionRepoCI
	repo, localDefault, ok, err := s.sessionRepo(ctx, id, &where)
	if err != nil {
		return nil, err
	}
	out := SessionCIStats{Connected: connected, Repo: where.Repo, Reason: where.Reason, PRs: []github.BranchPR{}}
	if !ok || !connected {
		return out, nil
	}
	gh, cancel := context.WithTimeout(ctx, statsGitHubBudget)
	defer cancel()
	prs, e := s.d.GitHub.RepoPulls(gh, repo)
	if e != nil {
		out.Error = e
		return out, nil //nolint:nilerr // GitHub's refusal is part of the answer
	}
	out.PRs = prs
	runs, e := s.d.GitHub.RepoRuns(gh, repo)
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
	sess, err := store.GetSession(ctx, s.d.Store.DB(), id)
	if err != nil {
		return nil, err
	}
	root := sess.RepoRoot
	if root == "" {
		root = sess.Cwd
	}
	if out.Board, err = s.composeBoard(ctx, gh, repo, root, localDefault, prs, runs, now); err != nil {
		return nil, err
	}
	// What the board draws on, and whether its newest read failed: the list
	// and the releases each keep their last answer when GitHub refuses.
	at, failed := s.d.GitHub.RepoPullsRead(repo)
	if rAt, rFailed := s.d.GitHub.RepoReleasesRead(repo); rAt > 0 {
		at = min(at, rAt)
		if failed == nil {
			failed = rFailed
		}
	}
	out.ReadAt = at
	if failed != nil {
		out.Error = failed
	}
	// What did not fit the budget is said too, not drawn as if current: the
	// releases never read, or open pull requests whose checks are an older
	// read.
	if out.Error == nil {
		stale := 0
		for _, c := range out.Board.Cards {
			if c.Stale {
				stale++
			}
		}
		slow := func(doing, what string) *github.Error {
			return &github.Error{Kind: github.KindNetwork, Doing: doing, At: now.UnixMilli(),
				Message: "GitHub did not answer in time for " + what + "; asked again on the next refresh"}
		}
		if rAt, _ := s.d.GitHub.RepoReleasesRead(repo); rAt == 0 {
			out.Error = slow("Listing the releases of "+repo.FullName(), "the releases")
		} else if stale > 0 {
			what := "1 open pull request’s checks"
			if stale > 1 {
				what = strconv.Itoa(stale) + " open pull requests’ checks"
			}
			out.Error = slow("Reading the open pull requests of "+repo.FullName(), what)
		}
	}
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
