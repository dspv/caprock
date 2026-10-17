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

// The release plan's pushed branches (owner, 2026-10-18: agents push
// branches and one batch pull request ships them): a branch ahead of the
// default branch, committed within branchRecent and with no open pull
// request, is checked for having landed by content (branches.Landed), the
// newest branchLandedMax of them.
const (
	branchRecent    = 14 * 24 * time.Hour
	branchLandedMax = 40
)

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
	// Landed: its changes are already on the default branch by content (a
	// squash merge, or inside another branch's batch); checked only for a
	// branch ahead of it, committed in the last 14 days, with no open pull
	// request. Absent: not landed, or not checked.
	Landed bool `json:"landed,omitempty"`
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
	deckFresh
}

func (a SessionBranches) stamped(f deckFresh) any {
	a.deckFresh = f
	return a
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

// markLanded sets Landed on the branches the release plan may list: ahead of
// base, committed within branchRecent, no open pull request, the newest
// branchLandedMax (bs is ordered newest first). A check that fails leaves the
// branch not landed: it is listed, never hidden on a guess.
func markLanded(ctx context.Context, dir, base string, bs []SessionBranch, now time.Time) {
	if base == "" {
		return
	}
	n := 0
	for i := range bs {
		b := &bs[i]
		if b.Default || b.Ahead == nil || *b.Ahead == 0 || b.SHA == "" || now.Sub(time.UnixMilli(b.CommittedMS)) > branchRecent || (b.PR != nil && b.PR.State == "open") {
			continue
		}
		if n >= branchLandedMax {
			return
		}
		n++
		if ok, err := branches.Landed(ctx, dir, base, b.SHA); err == nil {
			b.Landed = ok
		}
	}
}

// handleSessionBranches is the session deck's Branches view: the branches of
// the session's repository from local git (for-each-ref, kept 10 s), each
// with its pull request from one cached list when GitHub is connected, and
// the spend of Caprock's sessions on it from one indexed query. Nothing is
// sent to GitHub while it is not connected (rule 4). The composed answer is
// kept (deckcache.go).
func (s *Server) handleSessionBranches(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	connected := s.githubConnected()
	s.serveDeck(w, r, deckKey("branches", id, connected, 0), func(ctx context.Context) (deckAnswer, error) {
		return s.composeSessionBranches(ctx, id, connected)
	}, s.notFoundOrFail)
}

func (s *Server) composeSessionBranches(ctx context.Context, id string, connected bool) (deckAnswer, error) {
	sess, err := store.GetSession(ctx, s.d.Store.DB(), id)
	if err != nil {
		return nil, err
	}
	out := SessionBranches{Connected: connected, Branches: []SessionBranch{}}
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
		dir = sess.RepoRoot
		l, err = branches.List(ctx, dir, localDefault)
	}
	if err != nil {
		out.Reason = "no_repo"
		return out, nil //nolint:nilerr // not a git repository is an answer, not a failure
	}
	out.Default, out.Base, out.Current = l.Default, l.Base, l.Current
	spend, err := store.SpendByBranch(ctx, s.d.Store.DB(), sess.RepoRoot)
	if err != nil {
		return nil, err
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
	markLanded(ctx, dir, l.Base, out.Branches, now)
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
	return out, nil
}
