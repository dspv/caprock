package api

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/dspv/caprock/internal/github"
	"github.com/dspv/caprock/internal/projects"
)

// GitHub (WP-19, F14; contract in 03-contracts.md § GitHub). The daemon holds
// the token and is the only thing that talks to GitHub; nothing here ever
// returns it. Connecting, disconnecting and creating a repository are the
// machine's (settings and an outbound write nobody on a phone asked for,
// ADR-034); reading is every paired device's; opening a pull request and
// asking for its state again are a controller's, like a push.

// githubStatus maps a GitHub failure to the status Caprock answers with.
func githubStatus(e *github.Error) int {
	switch e.Kind {
	case github.KindNotConnected, github.KindState, github.KindDisabled, github.KindExists:
		return http.StatusConflict
	case github.KindRateLimit:
		return http.StatusTooManyRequests
	case github.KindInvalid:
		if e.Status == 0 {
			return http.StatusBadRequest // ours, before GitHub was asked
		}
	}
	// GitHub, or the way to it, said no: a bad gateway, with GitHub's own
	// status in the body.
	return http.StatusBadGateway
}

// githubFail answers an error from the GitHub service: {error, kind, doing,
// message, github_status?, retry_at?, needs?, pr?}. error is the whole
// sentence ("Opening the pull request: …"), what the interface shows.
func githubFail(w http.ResponseWriter, err error) {
	var ex *github.ExistsError
	var ge *github.Error
	switch {
	case errors.As(err, &ex):
		body := githubBody(ex.Err)
		if ex.PR != nil {
			body["pr"] = ex.PR
		}
		writeJSON(w, http.StatusConflict, body)
	case errors.As(err, &ge):
		if ge.RetryAt > 0 {
			secs := (ge.RetryAt - time.Now().UnixMilli() + 999) / 1000
			if secs > 0 {
				w.Header().Set("Retry-After", strconv.FormatInt(secs, 10))
			}
		}
		writeJSON(w, githubStatus(ge), githubBody(ge))
	default:
		changeFail(w, err) // a project, a worktree or the push before a pull request
	}
}

func githubBody(e *github.Error) map[string]any {
	body := map[string]any{"error": e.Error(), "kind": e.Kind, "doing": e.Doing, "message": e.Message}
	if e.Status != 0 {
		body["github_status"] = e.Status
	}
	if e.RetryAt != 0 {
		body["retry_at"] = e.RetryAt
	}
	if len(e.Needs) > 0 {
		body["needs"] = e.Needs
	}
	return body
}

// requireGitHub answers 501 when the daemon was built without the integration.
func (s *Server) requireGitHub(w http.ResponseWriter) bool {
	if s.d.GitHub == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "the GitHub integration is not available in this daemon"})
		return false
	}
	return true
}

func (s *Server) handleGitHubStatus(w http.ResponseWriter, _ *http.Request) {
	if !s.requireGitHub(w) {
		return
	}
	writeJSON(w, http.StatusOK, s.d.GitHub.Status())
}

func (s *Server) handleGitHubConnect(w http.ResponseWriter, r *http.Request) {
	if !s.requireGitHub(w) {
		return
	}
	var req struct {
		Source string `json:"source"`
		Token  string `json:"token"`
	}
	if !changeBody(w, r, &req) {
		return
	}
	st, e := s.d.GitHub.Connect(context.WithoutCancel(r.Context()), req.Source, req.Token)
	if e != nil {
		githubFail(w, e)
		return
	}
	writeJSON(w, http.StatusOK, st)
}

func (s *Server) handleGitHubDisconnect(w http.ResponseWriter, r *http.Request) {
	if !s.requireGitHub(w) {
		return
	}
	st, err := s.d.GitHub.Disconnect(context.WithoutCancel(r.Context()))
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, st)
}

func (s *Server) handleGitHubPatch(w http.ResponseWriter, r *http.Request) {
	if !s.requireGitHub(w) {
		return
	}
	var req struct {
		Notify *bool `json:"notify"`
	}
	if !changeBody(w, r, &req) {
		return
	}
	if req.Notify == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "nothing to change: send {notify}"})
		return
	}
	st, err := s.d.GitHub.SetNotify(*req.Notify)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, st)
}

func (s *Server) handleGitHubDeviceStart(w http.ResponseWriter, r *http.Request) {
	if !s.requireGitHub(w) {
		return
	}
	d, e := s.d.GitHub.StartDevice(context.WithoutCancel(r.Context()))
	if e != nil {
		githubFail(w, e)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"device": d})
}

func (s *Server) handleGitHubDeviceState(w http.ResponseWriter, _ *http.Request) {
	if !s.requireGitHub(w) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"device": s.d.GitHub.DeviceState()})
}

func (s *Server) handleGitHubDeviceCancel(w http.ResponseWriter, _ *http.Request) {
	if !s.requireGitHub(w) {
		return
	}
	s.d.GitHub.CancelDevice()
	writeJSON(w, http.StatusOK, map[string]any{"device": nil})
}

func (s *Server) handleGitHubOwners(w http.ResponseWriter, r *http.Request) {
	if !s.requireGitHub(w) {
		return
	}
	o, e := s.d.GitHub.Owners(r.Context())
	if e != nil {
		githubFail(w, e)
		return
	}
	writeJSON(w, http.StatusOK, o)
}

func (s *Server) handleGitHubRepos(w http.ResponseWriter, r *http.Request) {
	if !s.requireGitHub(w) {
		return
	}
	q := r.URL.Query()
	page, _ := strconv.Atoi(q.Get("page"))
	p, e := s.d.GitHub.Repos(r.Context(), q.Get("owner"), q.Get("q"), page)
	if e != nil {
		githubFail(w, e)
		return
	}
	writeJSON(w, http.StatusOK, p)
}

func (s *Server) handleGitHubPRs(w http.ResponseWriter, _ *http.Request) {
	if !s.requireGitHub(w) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"prs": s.d.GitHub.PRs()})
}

// githubTarget is changeTarget for the GitHub routes: the project, the
// worktree, and for a device's write a folder under home.
func (s *Server) githubTarget(w http.ResponseWriter, r *http.Request, write bool) (int64, string, bool) {
	if !s.requireGitHub(w) {
		return 0, "", false
	}
	return s.changeTarget(w, r, write)
}

func (s *Server) handleWorktreeGitHub(w http.ResponseWriter, r *http.Request) {
	id, wt, ok := s.githubTarget(w, r, false)
	if !ok {
		return
	}
	info, err := s.d.GitHub.Worktree(r.Context(), id, wt)
	if err != nil {
		githubFail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, info)
}

func (s *Server) handleWorktreeGitHubRefresh(w http.ResponseWriter, r *http.Request) {
	id, wt, ok := s.githubTarget(w, r, true)
	if !ok {
		return
	}
	info, err := s.d.GitHub.Refresh(context.WithoutCancel(r.Context()), id, wt)
	if err != nil {
		githubFail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, info)
}

func (s *Server) handleCreatePR(w http.ResponseWriter, r *http.Request) {
	id, wt, ok := s.githubTarget(w, r, true)
	if !ok {
		return
	}
	var req github.CreatePRRequest
	if !changeBody(w, r, &req) {
		return
	}
	res, err := s.d.GitHub.CreatePR(context.WithoutCancel(r.Context()), id, wt, req)
	if err != nil {
		githubFail(w, err)
		return
	}
	s.logDevice(r, "pull request opened", id, wt)
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) handleCreateRepo(w http.ResponseWriter, r *http.Request) {
	if !s.requireGitHub(w) || !s.requireProjects(w) {
		return
	}
	id, ok := pathID(r)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such project"})
		return
	}
	var req github.CreateRepoRequest
	if !changeBody(w, r, &req) {
		return
	}
	res, err := s.d.GitHub.CreateRepo(context.WithoutCancel(r.Context()), id, req)
	if err != nil {
		if res.Repo.FullName != "" {
			// The repository exists but the remote could not be set: say both.
			writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"error": err.Error(), "kind": projects.KindGit, "repo": res.Repo})
			return
		}
		githubFail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}
