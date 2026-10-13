package api

import (
	"context"
	"net/http"
	"strconv"
	"time"

	"github.com/dspv/caprock/internal/github"
	"github.com/dspv/caprock/internal/store"
)

// sessionPRsShown is how many of a session's pull requests the deck shows:
// the current one and up to three before it (owner, 2026-10-12: "plus at
// least a couple of previous PRs"). Each is one kept read (github.PullByURL).
const sessionPRsShown = 4

// SessionPRLive is one of a session's pull requests with what GitHub says of
// it now: state, checks and review. Live is absent while GitHub is not
// connected or could not be read; Error then says why, when it was asked.
type SessionPRLive struct {
	store.SessionPR
	Live  *github.PR    `json:"live,omitempty"`
	Error *github.Error `json:"error,omitempty"`
}

// SessionPRs is GET /v1/sessions/{id}/prs.
type SessionPRs struct {
	Connected bool            `json:"connected"`
	PRs       []SessionPRLive `json:"prs"`
	// FetchedAt is when the daemon composed this answer (Unix ms);
	// Refreshing is true when it is the last one kept while a newer one is
	// composed (deckcache.go).
	FetchedAt  int64 `json:"fetched_at"`
	Refreshing bool  `json:"refreshing,omitempty"`
}

func (a SessionPRs) stamped(at int64, refreshing bool) any {
	a.FetchedAt, a.Refreshing = at, refreshing
	return a
}

// handleSessionPRs is the session deck's PR cell: the session's latest pull
// requests and, with GitHub connected, their CI and review. Reads are kept
// per pull request (github.PullByURL), so polling this costs GitHub nothing
// between them, and the composed answer is kept (deckcache.go), so the cell
// opens on it at once; nothing is sent while GitHub is not connected (rule 4).
func (s *Server) handleSessionPRs(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	connected := s.githubConnected()
	s.serveDeck(w, r, deckKey("prs", id, connected, 0), func(ctx context.Context) (deckAnswer, error) {
		return s.composeSessionPRs(ctx, id, connected)
	}, s.fail)
}

func (s *Server) composeSessionPRs(ctx context.Context, id string, connected bool) (deckAnswer, error) {
	prs, err := store.SessionPRs(ctx, s.d.Store.DB(), id)
	if err != nil {
		return nil, err
	}
	if len(prs) > sessionPRsShown {
		prs = prs[:sessionPRsShown]
	}
	out := make([]SessionPRLive, len(prs))
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	for i, p := range prs {
		out[i] = SessionPRLive{SessionPR: p}
		if !connected {
			continue
		}
		if pr, e := s.d.GitHub.PullByURL(ctx, p.URL); e != nil {
			out[i].Error = e
		} else {
			out[i].Live = &pr
		}
	}
	return SessionPRs{Connected: connected, PRs: out}, nil
}

// sessionPR is one of the session's own pull requests by number, read live:
// the force actions below act only on a pull request the session recorded,
// never on any number a request names.
func (s *Server) sessionPR(w http.ResponseWriter, r *http.Request, doing string) (github.Repo, github.PR, bool) {
	if !s.requireGitHub(w) {
		return github.Repo{}, github.PR{}, false
	}
	n, err := strconv.Atoi(r.PathValue("number"))
	if err != nil || n <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad pull request number"})
		return github.Repo{}, github.PR{}, false
	}
	prs, err := store.SessionPRs(r.Context(), s.d.Store.DB(), r.PathValue("id"))
	if err != nil {
		s.fail(w, err)
		return github.Repo{}, github.PR{}, false
	}
	for _, p := range prs {
		if p.Number != n {
			continue
		}
		repo, _, ok := github.ParsePullURL(p.URL)
		if !ok {
			continue
		}
		live, e := s.d.GitHub.PullByURL(r.Context(), p.URL)
		if e != nil {
			githubFail(w, e)
			return github.Repo{}, github.PR{}, false
		}
		return repo, live, true
	}
	writeJSON(w, http.StatusNotFound, map[string]string{"error": doing + ": this session opened no pull request #" + strconv.Itoa(n)})
	return github.Repo{}, github.PR{}, false
}

// handleSessionPRRerun runs the checks of one of the session's pull requests
// again (the deck's Re-run checks, confirmed in its row): the failed jobs,
// else every finished run. A write to the user's own repository with their
// own token, on a click (rule 4); a refusal names the permission it needs.
func (s *Server) handleSessionPRRerun(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	r = r.WithContext(ctx)
	repo, pr, ok := s.sessionPR(w, r, "Re-running the checks")
	if !ok {
		return
	}
	out, e := s.d.GitHub.RerunChecks(ctx, repo, pr.HeadSHA)
	if e != nil {
		githubFail(w, e)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "mode": out.Mode, "runs": out.Runs, "jobs": out.Jobs})
}

// handleSessionPRUpdateBranch merges the base into one of the session's open
// pull requests on GitHub (the deck's Update branch, offered while it is
// behind and has no conflict). The head the deck last read guards against a
// push made since.
func (s *Server) handleSessionPRUpdateBranch(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	r = r.WithContext(ctx)
	repo, pr, ok := s.sessionPR(w, r, "Updating the branch")
	if !ok {
		return
	}
	doing := "Updating the branch of pull request #" + strconv.Itoa(pr.Number)
	if pr.State != "open" {
		writeJSON(w, http.StatusConflict, map[string]any{"error": doing + ": it is " + pr.State + ".", "kind": github.KindState})
		return
	}
	if pr.Mergeable != nil && !*pr.Mergeable {
		writeJSON(w, http.StatusConflict, map[string]any{"error": doing + ": it conflicts with " + pr.Base + "; the conflicts need resolving first.", "kind": github.KindState})
		return
	}
	if e := s.d.GitHub.UpdateBranch(ctx, repo, pr.Number, pr.HeadSHA); e != nil {
		githubFail(w, e)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
