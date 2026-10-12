package github

import (
	"context"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// The session deck's Branches view puts each branch's pull request beside it
// (owner, 2026-10-12, translated: "seeing branches with statistics would also
// be interesting"). One list of the repository's most recently updated pull
// requests answers it for every branch at once, so a branch costs no request
// of its own.
const (
	// branchPullsRead is how many of the most recently updated pull requests
	// are listed: one page.
	branchPullsRead = 50
	// branchPullsKept is how long that list is reused. A conditional request
	// after it costs GitHub a 304 when nothing changed.
	branchPullsKept = 2 * time.Minute
)

// BranchPR is the pull request a branch is the head of.
type BranchPR struct {
	Number  int    `json:"number"`
	URL     string `json:"url"`
	Title   string `json:"title,omitempty"`
	State   string `json:"state"` // open | closed | merged
	Draft   bool   `json:"draft,omitempty"`
	Base    string `json:"base,omitempty"`
	HeadSHA string `json:"head_sha,omitempty"`
}

type branchPullsEntry struct {
	m  map[string]BranchPR
	at time.Time
}

type branchPullsCache struct {
	mu sync.Mutex
	m  map[string]branchPullsEntry
}

// pickBranchPRs maps each head branch of the repository's own pull requests
// (a fork's are left out: its branch is not this repository's) to the one
// shown: the open one, else the most recently updated. list is newest first.
func pickBranchPRs(repo Repo, list []apiPull) map[string]BranchPR {
	out := map[string]BranchPR{}
	for _, p := range list {
		if p.Head.Ref == "" || (p.Head.Repo != nil && !strings.EqualFold(p.Head.Repo.FullName, repo.FullName())) {
			continue
		}
		have, ok := out[p.Head.Ref]
		if ok && (have.State == "open" || p.state() != "open") {
			continue
		}
		out[p.Head.Ref] = BranchPR{Number: p.Number, URL: p.HTMLURL, Title: p.Title, State: p.state(), Draft: p.Draft, Base: p.Base.Ref, HeadSHA: p.Head.SHA}
	}
	return out
}

// PullsByBranch is the pull request of each branch of repo, from one list of
// its 50 most recently updated, kept branchPullsKept. A failed read keeps the
// last answer, if any. Nothing is sent while GitHub is not connected.
func (s *Service) PullsByBranch(ctx context.Context, repo Repo) (map[string]BranchPR, *Error) {
	s.init()
	key := repo.FullName()
	now := s.Now()
	s.branchPulls.mu.Lock()
	if s.branchPulls.m == nil {
		s.branchPulls.m = map[string]branchPullsEntry{}
	}
	e, have := s.branchPulls.m[key]
	s.branchPulls.mu.Unlock()
	if have && now.Sub(e.at) < branchPullsKept {
		return e.m, nil
	}
	if s.source() == "" {
		return nil, errorf(KindNotConnected, "Listing pull requests", "GitHub is not connected.")
	}
	doing := "Listing the pull requests of " + key
	v := url.Values{"state": {"all"}, "sort": {"updated"}, "direction": {"desc"}, "per_page": {strconv.Itoa(branchPullsRead)}}
	res, ce := s.call(ctx, request{method: http.MethodGet, path: repoPath(repo) + "/pulls?" + v.Encode(), doing: doing})
	if ce != nil {
		if have {
			return e.m, nil
		}
		return nil, ce
	}
	var list []apiPull
	if de := decode(res, doing, &list); de != nil {
		if have {
			return e.m, nil
		}
		return nil, de
	}
	m := pickBranchPRs(repo, list)
	s.branchPulls.mu.Lock()
	bound(s.branchPulls.m, key, func(v branchPullsEntry) time.Time { return v.at })
	s.branchPulls.m[key] = branchPullsEntry{m: m, at: now}
	s.branchPulls.mu.Unlock()
	if s.OnMerged != nil {
		if merged := newlyMerged(e.m, m); len(merged) > 0 {
			s.OnMerged(repo, merged)
		}
	}
	return m, nil
}

// newlyMerged lists the branches merged in now and not in before, sorted.
func newlyMerged(before, now map[string]BranchPR) []string {
	var out []string
	for b, p := range now {
		if p.State == "merged" && before[b].State != "merged" {
			out = append(out, b)
		}
	}
	sort.Strings(out)
	return out
}

// CachedBranchPR is the pull request of a branch from the last list read
// for the Branches view, however old; nothing is sent. ok is false when no
// list was read or the branch has none in it.
func (s *Service) CachedBranchPR(repo Repo, branch string) (BranchPR, bool) {
	s.branchPulls.mu.Lock()
	defer s.branchPulls.mu.Unlock()
	e, have := s.branchPulls.m[repo.FullName()]
	if !have {
		return BranchPR{}, false
	}
	p, ok := e.m[branch]
	return p, ok
}
