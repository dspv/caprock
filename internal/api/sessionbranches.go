package api

import (
	"context"
	"net/http"
	"sort"
	"time"

	"github.com/dspv/caprock/internal/branches"
	"github.com/dspv/caprock/internal/github"
	"github.com/dspv/caprock/internal/store"
)

// branchLivePRs bounds the open pull requests whose checks are read for the
// Branches view (github.PullByURL, kept and shared with the PRs view).
const branchLivePRs = 8

// SessionBranch is one row of the deck's Branches view: what git knows of
// the branch, its pull request, what Caprock's sessions on it cost.
type SessionBranch struct {
	branches.Branch
	// PR is the branch's pull request (the open one, else the newest) from
	// one list of the repository's pull requests; absent while GitHub is not
	// connected.
	PR *github.BranchPR `json:"pr,omitempty"`
	// Live is an open PR as the PRs view reads it, with its checks.
	Live *github.PR `json:"live,omitempty"`
	// CostUSD, Sessions and Agents sum the sessions recorded on this branch
	// of this repository (store.SpendByBranch).
	CostUSD  float64  `json:"cost_usd"`
	Sessions int      `json:"sessions"`
	Agents   []string `json:"agents"`
	// SessionAt is the newest event of those sessions; ActivityAt the later
	// of it and the last commit, what the rows are ordered by.
	SessionAt  int64 `json:"session_at,omitempty"`
	ActivityAt int64 `json:"activity_at"`
	// Stale: no commit in 30 days and no open pull request.
	Stale bool `json:"stale,omitempty"`
}

// SessionBranches is GET /v1/sessions/{id}/branches.
type SessionBranches struct {
	Connected bool `json:"connected"`
	// Repo is "owner/name" when the remote is on GitHub.
	Repo string `json:"repo,omitempty"`
	// Reason says why there are no branches: no_repo (not a git repository).
	Reason   string          `json:"reason,omitempty"`
	Default  string          `json:"default,omitempty"`
	Base     string          `json:"base,omitempty"`
	Current  string          `json:"current,omitempty"`
	Branches []SessionBranch `json:"branches"`
	Error    *github.Error   `json:"error,omitempty"`
}

// OrderBranches puts the current branch first, then the rest by their last
// activity, newest first, the name breaking ties.
func OrderBranches(bs []SessionBranch) {
	sort.SliceStable(bs, func(i, j int) bool {
		a, b := bs[i], bs[j]
		if a.Current != b.Current {
			return a.Current
		}
		if a.ActivityAt != b.ActivityAt {
			return a.ActivityAt > b.ActivityAt
		}
		return a.Name < b.Name
	})
}

// handleSessionBranches is the session deck's Branches view: the branches of
// the session's repository from local git (for-each-ref, kept 10 s), each
// with its pull request from one cached list when GitHub is connected, and
// the spend of Caprock's sessions on it from one indexed query. Nothing is
// sent to GitHub while it is not connected (rule 4).
func (s *Server) handleSessionBranches(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	sess, err := store.GetSession(ctx, s.d.Store.DB(), r.PathValue("id"))
	if err != nil {
		s.notFoundOrFail(w, err)
		return
	}
	out := SessionBranches{Connected: s.d.GitHub != nil && s.d.GitHub.Status().Connected, Branches: []SessionBranch{}}
	dir := sess.Cwd
	if dir == "" {
		dir = sess.RepoRoot
	}
	var repo github.Repo
	hasRepo := false
	localDefault := ""
	if rc, ok := s.repos.get(ctx, sess.Cwd); ok {
		localDefault = rc.DefaultBranch
		if rc.URL != "" {
			repo, hasRepo = github.ParseRemote(rc.URL)
			if hasRepo {
				out.Repo = repo.FullName()
			}
		}
	}
	l, err := branches.List(ctx, dir, localDefault)
	if err != nil && sess.RepoRoot != "" && sess.RepoRoot != dir {
		l, err = branches.List(ctx, sess.RepoRoot, localDefault)
	}
	if err != nil {
		out.Reason = "no_repo"
		writeJSON(w, http.StatusOK, out)
		return
	}
	out.Default, out.Base, out.Current = l.Default, l.Base, l.Current
	spend, err := store.SpendByBranch(ctx, s.d.Store.DB(), sess.RepoRoot)
	if err != nil {
		s.fail(w, err)
		return
	}
	var prs map[string]github.BranchPR
	if out.Connected && hasRepo {
		prs, out.Error = s.d.GitHub.PullsByBranch(ctx, repo)
	}
	now := time.Now()
	for _, b := range l.Branches {
		row := SessionBranch{Branch: b, Agents: []string{}}
		if sp, ok := spend[b.Name]; ok {
			row.CostUSD, row.Sessions, row.Agents, row.SessionAt = sp.CostUSD, sp.Sessions, sp.Agents, sp.LastAt
		}
		if p, ok := prs[b.Name]; ok && !b.Default {
			row.PR = &p
		}
		row.ActivityAt = max(b.CommittedMS, row.SessionAt)
		row.Stale = branches.IsStale(b, row.PR != nil && row.PR.State == "open", now)
		out.Branches = append(out.Branches, row)
	}
	OrderBranches(out.Branches)
	// The open PRs' checks, for their mini pipelines: the newest rows first,
	// each a read the PRs view shares.
	n := 0
	for i := range out.Branches {
		p := out.Branches[i].PR
		if p == nil || p.State != "open" || n >= branchLivePRs {
			continue
		}
		n++
		if live, e := s.d.GitHub.PullByURL(ctx, p.URL); e == nil {
			out.Branches[i].Live = &live
		}
	}
	writeJSON(w, http.StatusOK, out)
}
