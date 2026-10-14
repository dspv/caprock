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
	// Live is the pull request as GitHub returned it: its review, merge
	// state and diff size, for the PRs & CI tab's detail.
	Live *github.PR `json:"live,omitempty"`
}

// SessionCI is GET /v1/sessions/{id}/ci.
type SessionCI struct {
	Connected bool          `json:"connected"`
	PR        *SessionCIPR  `json:"pr,omitempty"`
	CI        *github.CI    `json:"ci,omitempty"`
	Error     *github.Error `json:"error,omitempty"`
	deckFresh
}

func (a SessionCI) stamped(f deckFresh) any {
	a.deckFresh = f
	return a
}

// sessionCIPR picks the pull request whose CI the deck shows: the one
// numbered want among the session's latest (a click on its mini pipeline in
// the PRs cell), else the session's open one, else its newest. Each is read
// through github.PullByURL, which keeps it, so the PRs cell and this one
// share the reads.
func (s *Server) sessionCIPR(ctx context.Context, id string, want int) (*SessionCIPR, *github.Error, error) {
	prs, err := store.SessionPRs(ctx, s.d.Store.DB(), id)
	if err != nil {
		return nil, nil, err
	}
	if len(prs) > sessionPRsShown {
		prs = prs[:sessionPRsShown]
	}
	if want > 0 {
		found := false
		for _, p := range prs {
			if p.Number == want {
				prs, found = []store.SessionPR{p}, true
				break
			}
		}
		// Not the session's own: one of its repository's that the PRs & CI
		// tab listed, and only such (s.repoPRURL).
		if !found {
			if link, ok := s.repoPRURL(ctx, id, want); ok {
				prs = []store.SessionPR{{SessionID: id, URL: link, Number: want}}
			}
		}
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
		c := &SessionCIPR{Number: live.Number, URL: live.URL, Title: live.Title, State: live.State, Repo: repo.FullName(), HeadSHA: live.HeadSHA, Live: &live}
		if live.State == "open" {
			return c, nil, nil
		}
		if pick == nil {
			pick = c
		}
	}
	return pick, firstErr, nil
}

// wantPR is ?pr=N, the pull request asked for by number; 0 when none.
func wantPR(r *http.Request) int {
	n, err := strconv.Atoi(r.URL.Query().Get("pr"))
	if err != nil || n < 0 {
		return 0
	}
	return n
}

// handleSessionCI is the session deck's CI panel: the GitHub Actions runs of
// the head commit of the session's open pull request (else its newest), with
// every job and step and what each took. Kept per commit (github.CIBySHA):
// 10 s while a job runs, 2 min once settled. Nothing is sent while GitHub is
// not connected (rule 4). The composed answer is kept (deckcache.go).
func (s *Server) handleSessionCI(w http.ResponseWriter, r *http.Request) {
	id, want := r.PathValue("id"), wantPR(r)
	connected := s.githubConnected()
	s.serveDeck(w, r, deckKey("ci", id, connected, want), func(ctx context.Context) (deckAnswer, error) {
		return s.composeSessionCI(ctx, id, want, connected)
	}, s.fail)
}

func (s *Server) composeSessionCI(ctx context.Context, id string, want int, connected bool) (deckAnswer, error) {
	if !connected {
		prs, err := store.SessionPRs(ctx, s.d.Store.DB(), id)
		if err != nil {
			return nil, err
		}
		out := SessionCI{}
		if len(prs) > 0 {
			repo, _, _ := github.ParsePullURL(prs[0].URL)
			out.PR = &SessionCIPR{Number: prs[0].Number, URL: prs[0].URL, Title: prs[0].Title, Repo: repo.FullName()}
		}
		return out, nil
	}
	pr, perr, err := s.sessionCIPR(ctx, id, want)
	if err != nil {
		return nil, err
	}
	out := SessionCI{Connected: true, PR: pr, Error: perr}
	if pr != nil && pr.HeadSHA != "" {
		repo, _, _ := github.ParsePullURL(pr.URL)
		if ci, e := s.d.GitHub.CIBySHA(ctx, repo, pr.HeadSHA); e != nil {
			out.Error = e
		} else {
			ci.Runs = s.d.GitHub.WithBaselines(ctx, repo, ci.Runs)
			out.CI = &ci
			out.Error = nil
		}
	}
	return out, nil
}

// SessionRepoCI is GET /v1/sessions/{id}/ci/release and …/ci/main: the
// release build and the default branch's CI of the session's repository.
type SessionRepoCI struct {
	Connected bool `json:"connected"`
	// Repo is "owner/name", read from the session's working directory's remote.
	Repo string `json:"repo,omitempty"`
	// Reason says why there is no repository: no_repo (not a git repository,
	// or no remote) or not_github (a remote elsewhere than github.com).
	Reason  string            `json:"reason,omitempty"`
	Branch  string            `json:"branch,omitempty"`
	Release *github.ReleaseCI `json:"release,omitempty"`
	CI      *github.CI        `json:"ci,omitempty"`
	Error   *github.Error     `json:"error,omitempty"`
	deckFresh
}

func (a SessionRepoCI) stamped(f deckFresh) any {
	a.deckFresh = f
	return a
}

// sessionRepo is the GitHub repository of a session's working directory and
// its default branch as git knows it locally (else ""), as the session page
// resolves it (repoCache). ok is false with the reason filled in out.
func (s *Server) sessionRepo(ctx context.Context, id string, out *SessionRepoCI) (github.Repo, string, bool, error) {
	sess, err := store.GetSession(ctx, s.d.Store.DB(), id)
	if err != nil {
		return github.Repo{}, "", false, err
	}
	r, ok := s.repos.get(ctx, sess.Cwd)
	if !ok || r.URL == "" {
		out.Reason = "no_repo"
		return github.Repo{}, "", false, nil
	}
	repo, ok := github.ParseRemote(r.URL)
	if !ok {
		out.Reason = "not_github"
		return github.Repo{}, "", false, nil
	}
	out.Repo = repo.FullName()
	return repo, r.DefaultBranch, true, nil
}

// defaultBranch is the local answer, else GitHub's.
func (s *Server) defaultBranch(ctx context.Context, repo github.Repo, local string) (string, *github.Error) {
	if local != "" {
		return local, nil
	}
	return s.d.GitHub.DefaultBranch(ctx, repo)
}

// handleSessionCIRepo serves the CI cell's Release and Main views: the newest
// release run of the session's repository, or the newest run of each
// workflow on its default branch, kept as github.ReleaseByRepo and
// github.MainCI keep them, and the composed answer kept (deckcache.go).
// Nothing is sent while GitHub is not connected.
func (s *Server) handleSessionCIRepo(view string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		connected := s.githubConnected()
		s.serveDeck(w, r, deckKey(view, id, connected, 0), func(ctx context.Context) (deckAnswer, error) {
			return s.composeSessionCIRepo(ctx, view, id, connected)
		}, s.notFoundOrFail)
	}
}

func (s *Server) composeSessionCIRepo(ctx context.Context, view, id string, connected bool) (deckAnswer, error) {
	out := SessionRepoCI{Connected: connected}
	repo, local, ok, err := s.sessionRepo(ctx, id, &out)
	if err != nil {
		return nil, err
	}
	if !ok || !out.Connected {
		if ok && view == "main" {
			out.Branch = local
		}
		return out, nil
	}
	branch, e := s.defaultBranch(ctx, repo, local)
	if e != nil {
		out.Error = e
		return out, nil //nolint:nilerr // GitHub's refusal is part of the answer
	}
	if view == "release" {
		rel, e := s.d.GitHub.ReleaseByRepo(ctx, repo, branch)
		if e != nil {
			out.Error = e
		} else {
			if rel.Run != nil {
				runs := s.d.GitHub.WithBaselines(ctx, repo, []github.CIRun{*rel.Run})
				rel.Run = &runs[0]
			}
			out.Release = &rel
		}
	} else {
		out.Branch = branch
		ci, e := s.d.GitHub.MainCI(ctx, repo, branch)
		if e != nil {
			out.Error = e
		} else {
			ci.Runs = s.d.GitHub.WithBaselines(ctx, repo, ci.Runs)
			out.CI = &ci
		}
	}
	return out, nil
}

// ciRunsOf is the runs the CI cell shows for this session in one view (pr,
// release or main), and the repository they are of; nil runs and a message
// when the view has none.
func (s *Server) ciRunsOf(ctx context.Context, id, view string, want int) (github.Repo, []github.CIRun, string, *github.Error, error) {
	switch view {
	case "release", "main":
		var out SessionRepoCI
		repo, local, ok, err := s.sessionRepo(ctx, id, &out)
		if err != nil || !ok {
			return repo, nil, "this session's directory has no GitHub repository", nil, err
		}
		branch, e := s.defaultBranch(ctx, repo, local)
		if e != nil {
			return repo, nil, "", e, nil
		}
		if view == "release" {
			rel, e := s.d.GitHub.ReleaseByRepo(ctx, repo, branch)
			if e != nil || rel.Run == nil {
				return repo, nil, "this repository has no release run", e, nil
			}
			return repo, []github.CIRun{*rel.Run}, "", nil, nil
		}
		ci, e := s.d.GitHub.MainCI(ctx, repo, branch)
		return repo, ci.Runs, "", e, nil
	}
	pr, _, err := s.sessionCIPR(ctx, id, want)
	if err != nil {
		return github.Repo{}, nil, "", nil, err
	}
	if pr == nil || pr.HeadSHA == "" {
		return github.Repo{}, nil, "this session has no pull request with CI", nil, nil
	}
	repo, _, _ := github.ParsePullURL(pr.URL)
	ci, e := s.d.GitHub.CIBySHA(ctx, repo, pr.HeadSHA)
	return repo, ci.Runs, "", e, nil
}

// handleSessionCILog is the end of one failed job's log, on demand: only a
// job of the CI the deck shows for this session in the view asked for
// (?view=pr, the default, release or main), so the route reads nothing the
// panel did not list.
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
	repo, runs, none, e, err := s.ciRunsOf(ctx, r.PathValue("id"), r.URL.Query().Get("view"), wantPR(r))
	if err != nil {
		s.notFoundOrFail(w, err)
		return
	}
	if e != nil {
		githubFail(w, e)
		return
	}
	if none != "" {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": none})
		return
	}
	found := false
	for _, run := range runs {
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
