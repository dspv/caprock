package api

import (
	"context"
	"net/http"
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
