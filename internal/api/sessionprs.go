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

// handleSessionPRs is the session deck's PR cell: the session's latest pull
// requests and, with GitHub connected, their CI and review. Reads are kept
// per pull request (github.PullByURL), so polling this costs GitHub nothing
// between them; nothing is sent while GitHub is not connected (rule 4).
func (s *Server) handleSessionPRs(w http.ResponseWriter, r *http.Request) {
	prs, err := store.SessionPRs(r.Context(), s.d.Store.DB(), r.PathValue("id"))
	if err != nil {
		s.fail(w, err)
		return
	}
	if len(prs) > sessionPRsShown {
		prs = prs[:sessionPRsShown]
	}
	connected := s.d.GitHub != nil && s.d.GitHub.Status().Connected
	out := make([]SessionPRLive, len(prs))
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
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
	writeJSON(w, http.StatusOK, map[string]any{"connected": connected, "prs": out})
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
