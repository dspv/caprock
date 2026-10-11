package api

import (
	"context"
	"net/http"
	"strconv"
	"time"

	"github.com/dspv/caprock/internal/github"
	"github.com/dspv/caprock/internal/store"
)

// SessionCIPR is the pull request whose CI the deck shows.
type SessionCIPR struct {
	Number  int    `json:"number"`
	URL     string `json:"url"`
	Title   string `json:"title,omitempty"`
	State   string `json:"state,omitempty"` // open | merged | closed; "" when GitHub was not read
	Repo    string `json:"repo"`
	HeadSHA string `json:"head_sha,omitempty"`
}

// SessionCI is GET /v1/sessions/{id}/ci.
type SessionCI struct {
	Connected bool          `json:"connected"`
	PR        *SessionCIPR  `json:"pr,omitempty"`
	CI        *github.CI    `json:"ci,omitempty"`
	Error     *github.Error `json:"error,omitempty"`
}

// sessionCIPR picks the pull request whose CI the deck shows: the session's
// open one, else its newest. Each is read through github.PullByURL, which
// keeps it, so the PRs cell and this one share the reads.
func (s *Server) sessionCIPR(ctx context.Context, id string) (*SessionCIPR, *github.Error, error) {
	prs, err := store.SessionPRs(ctx, s.d.Store.DB(), id)
	if err != nil {
		return nil, nil, err
	}
	if len(prs) > sessionPRsShown {
		prs = prs[:sessionPRsShown]
	}
	var pick *SessionCIPR
	var firstErr *github.Error
	for _, p := range prs {
		repo, _, ok := github.ParsePullURL(p.URL)
		if !ok {
			continue
		}
		live, e := s.d.GitHub.PullByURL(ctx, p.URL)
		if e != nil {
			if firstErr == nil {
				firstErr = e
			}
			continue
		}
		c := &SessionCIPR{Number: live.Number, URL: live.URL, Title: live.Title, State: live.State, Repo: repo.FullName(), HeadSHA: live.HeadSHA}
		if live.State == "open" {
			return c, nil, nil
		}
		if pick == nil {
			pick = c
		}
	}
	return pick, firstErr, nil
}

// handleSessionCI is the session deck's CI panel: the GitHub Actions runs of
// the head commit of the session's open pull request (else its newest), with
// every job and step and what each took. Kept per commit (github.CIBySHA):
// 10 s while a job runs, 2 min once settled. Nothing is sent while GitHub is
// not connected (rule 4).
func (s *Server) handleSessionCI(w http.ResponseWriter, r *http.Request) {
	connected := s.d.GitHub != nil && s.d.GitHub.Status().Connected
	if !connected {
		prs, err := store.SessionPRs(r.Context(), s.d.Store.DB(), r.PathValue("id"))
		if err != nil {
			s.fail(w, err)
			return
		}
		out := SessionCI{}
		if len(prs) > 0 {
			repo, _, _ := github.ParsePullURL(prs[0].URL)
			out.PR = &SessionCIPR{Number: prs[0].Number, URL: prs[0].URL, Title: prs[0].Title, Repo: repo.FullName()}
		}
		writeJSON(w, http.StatusOK, out)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	pr, perr, err := s.sessionCIPR(ctx, r.PathValue("id"))
	if err != nil {
		s.fail(w, err)
		return
	}
	out := SessionCI{Connected: true, PR: pr, Error: perr}
	if pr != nil && pr.HeadSHA != "" {
		repo, _, _ := github.ParsePullURL(pr.URL)
		if ci, e := s.d.GitHub.CIBySHA(ctx, repo, pr.HeadSHA); e != nil {
			out.Error = e
		} else {
			out.CI = &ci
			out.Error = nil
		}
	}
	writeJSON(w, http.StatusOK, out)
}

// handleSessionCILog is the end of one failed job's log, on demand: only a
// job of the CI the deck shows for this session, so the route reads nothing
// the panel did not list.
func (s *Server) handleSessionCILog(w http.ResponseWriter, r *http.Request) {
	jobID, err := strconv.ParseInt(r.PathValue("job"), 10, 64)
	if err != nil || jobID <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "not a job id"})
		return
	}
	if s.d.GitHub == nil || !s.d.GitHub.Status().Connected {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "GitHub is not connected.", "kind": github.KindNotConnected})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	pr, _, err := s.sessionCIPR(ctx, r.PathValue("id"))
	if err != nil {
		s.fail(w, err)
		return
	}
	if pr == nil || pr.HeadSHA == "" {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "this session has no pull request with CI"})
		return
	}
	repo, _, _ := github.ParsePullURL(pr.URL)
	ci, e := s.d.GitHub.CIBySHA(ctx, repo, pr.HeadSHA)
	if e != nil {
		githubFail(w, e)
		return
	}
	found := false
	for _, run := range ci.Runs {
		for _, j := range run.Jobs {
			found = found || j.ID == jobID
		}
	}
	if !found {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such job in this session's CI"})
		return
	}
	lg, e := s.d.GitHub.JobLog(ctx, repo, jobID)
	if e != nil {
		githubFail(w, e)
		return
	}
	writeJSON(w, http.StatusOK, lg)
}
