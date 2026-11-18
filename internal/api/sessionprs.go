package api

import (
	"context"
	"net/http"
	"sort"
	"strconv"
	"strings"
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
	// How fresh it is: when the daemon composed it, whether a newer one is
	// being composed, and a newer one's failure (deckcache.go).
	deckFresh
}

func (a SessionPRs) stamped(f deckFresh) any {
	a.deckFresh = f
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
	s.serveDeckOrQuick(w, r, deckKey("prs", id, connected, 0), func(ctx context.Context) (deckAnswer, error) {
		return s.composeSessionPRs(ctx, id, connected)
	}, func(ctx context.Context) (deckAnswer, error) {
		return s.recordedSessionPRs(ctx, id, connected)
	}, s.fail)
}

// recordedSessionPRs is the session's pull requests as the daemon recorded
// them, each with GitHub's live state only where the GitHub service already
// keeps a read of it: the quick answer while the composed one still waits on
// GitHub (serveDeckOrQuick). Nothing is sent.
func (s *Server) recordedSessionPRs(ctx context.Context, id string, connected bool) (deckAnswer, error) {
	prs, err := store.SessionPRs(ctx, s.d.Store.DB(), id)
	if err != nil {
		return nil, err
	}
	if len(prs) > sessionPRsShown {
		prs = prs[:sessionPRsShown]
	}
	out := make([]SessionPRLive, len(prs))
	for i, p := range prs {
		out[i] = SessionPRLive{SessionPR: p}
		// What GitHub said of it when last read, kept per pull request:
		// the right panel draws its CI line from it at once (2026-11-18).
		if connected {
			if pr, _, ok := s.d.GitHub.CachedPull(p.URL); ok {
				out[i].Live = &pr
			}
		}
	}
	return SessionPRs{Connected: connected, PRs: out}, nil
}

func (s *Server) composeSessionPRs(ctx context.Context, id string, connected bool) (deckAnswer, error) {
	prs, err := s.sessionPRList(ctx, id)
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

// sessionPR is one of the session's own pull requests by number, read live,
// or one of its repository's that the PRs & CI tab listed: the force actions
// below act only on a pull request the session recorded or the tab showed,
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
	prs, err := s.sessionPRList(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, err)
		return github.Repo{}, github.PR{}, false
	}
	if !hasPR(prs, n) {
		if link, ok := s.repoPRURL(r.Context(), r.PathValue("id"), n); ok {
			prs = append(prs, store.SessionPR{URL: link, Number: n})
		}
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
	writeJSON(w, http.StatusNotFound, map[string]string{"error": doing + ": #" + strconv.Itoa(n) + " is neither this session's pull request nor one the PRs & CI tab listed"})
	return github.Repo{}, github.PR{}, false
}

// sessionPushedBranches is how many of a session's latest pushed branches
// sessionPRList looks up a pull request for.
const sessionPushedBranches = 5

// sessionPRList is the session's pull requests, the latest first: the ones it
// recorded (a `gh pr` command, session_prs) and, with GitHub connected, the
// ones whose head is a branch it pushed (session_branches): a pull request a
// script opened, or one the agent never ran `gh pr` on, which otherwise left
// the CI cell on an older one (the owner saw "#915 merged" while his PR was
// #917). The branches are matched against the repository's one kept list of
// pull requests (github.PullsByBranch, 2 min), so a branch costs no request
// of its own. A push to the default branch is no pull request. On any GitHub
// error the recorded ones alone are the answer. A recorded row wins over a
// found one with the same URL, keeping the later of their times.
func (s *Server) sessionPRList(ctx context.Context, id string) ([]store.SessionPR, error) {
	prs, err := store.SessionPRs(ctx, s.d.Store.DB(), id)
	if err != nil || !s.githubConnected() {
		return prs, err
	}
	pushed, err := store.SessionBranches(ctx, s.d.Store.DB(), id)
	if err != nil {
		return nil, err
	}
	if len(pushed) == 0 {
		return prs, nil
	}
	var where SessionRepoCI
	repo, local, ok, rerr := s.sessionRepo(ctx, id, &where)
	if rerr != nil || !ok {
		return prs, nil //nolint:nilerr // no repository to look in: the recorded ones are the answer
	}
	byBranch, e := s.d.GitHub.PullsByBranch(ctx, repo)
	if e != nil {
		return prs, nil //nolint:nilerr // GitHub failing: the recorded ones are the answer
	}
	if len(pushed) > sessionPushedBranches {
		pushed = pushed[:sessionPushedBranches]
	}
	for _, b := range pushed {
		if b.Branch == local || b.Branch == "master" || b.Branch == "main" {
			continue
		}
		p, ok := byBranch[b.Branch]
		if !ok || p.URL == "" || p.Number <= 0 {
			continue
		}
		found := false
		for i := range prs {
			if strings.EqualFold(prs[i].URL, p.URL) {
				prs[i].LastAt = max(prs[i].LastAt, b.PushedAt)
				found = true
				break
			}
		}
		if !found {
			prs = append(prs, store.SessionPR{SessionID: id, URL: p.URL, Number: p.Number, Title: p.Title, LastAt: b.PushedAt})
		}
	}
	sort.SliceStable(prs, func(i, j int) bool { return prs[i].LastAt > prs[j].LastAt })
	return prs, nil
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
