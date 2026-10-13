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
	// CreatedAt and MergedAt are GitHub's stamps (unix ms), MergedAt 0 until
	// merged: what the PRs & CI tab's merges per day and time to merge count.
	CreatedAt int64 `json:"created_at,omitempty"`
	MergedAt  int64 `json:"merged_at,omitempty"`
	// Head is the head branch; Author and AuthorAvatar who opened it, as
	// GitHub names them (the avatar a URL on avatars.githubusercontent.com):
	// the PRs & CI board's cards and the Now screen's "who".
	Head         string `json:"head,omitempty"`
	Author       string `json:"author,omitempty"`
	AuthorAvatar string `json:"author_avatar,omitempty"`
}

type branchPullsEntry struct {
	m map[string]BranchPR
	// list is every pull request of the repository's own in the answer,
	// most recently updated first (a fork's left out, as in m).
	list []BranchPR
	at   time.Time
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
	for _, b := range ownPulls(repo, list) {
		have, ok := out[b.branch]
		if ok && (have.State == "open" || b.pr.State != "open") {
			continue
		}
		out[b.branch] = b.pr
	}
	return out
}

type ownPull struct {
	branch string
	pr     BranchPR
}

// ownPulls is the repository's own pull requests in list, in its order: a
// fork's are left out, its branch not being this repository's.
func ownPulls(repo Repo, list []apiPull) []ownPull {
	out := make([]ownPull, 0, len(list))
	for _, p := range list {
		if p.Head.Ref == "" || (p.Head.Repo != nil && !strings.EqualFold(p.Head.Repo.FullName, repo.FullName())) {
			continue
		}
		pr := BranchPR{Number: p.Number, URL: p.HTMLURL, Title: p.Title, State: p.state(), Draft: p.Draft,
			Base: p.Base.Ref, HeadSHA: p.Head.SHA, CreatedAt: unixMS(p.CreatedAt), MergedAt: p.mergedMS(), Head: p.Head.Ref}
		if p.User != nil {
			pr.Author, pr.AuthorAvatar = p.User.Login, p.User.AvatarURL
		}
		out = append(out, ownPull{branch: p.Head.Ref, pr: pr})
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
	own := ownPulls(repo, list)
	all := make([]BranchPR, len(own))
	for i, o := range own {
		all[i] = o.pr
	}
	s.branchPulls.mu.Lock()
	bound(s.branchPulls.m, key, func(v branchPullsEntry) time.Time { return v.at })
	s.branchPulls.m[key] = branchPullsEntry{m: m, list: all, at: now}
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

// RepoPulls is the repository's own pull requests from the same list
// PullsByBranch reads and keeps (its 50 most recently updated, newest first),
// so asking for both costs one read. Nothing is sent while GitHub is not
// connected.
func (s *Service) RepoPulls(ctx context.Context, repo Repo) ([]BranchPR, *Error) {
	if _, e := s.PullsByBranch(ctx, repo); e != nil {
		return nil, e
	}
	s.branchPulls.mu.Lock()
	defer s.branchPulls.mu.Unlock()
	list := s.branchPulls.m[repo.FullName()].list
	return append([]BranchPR(nil), list...), nil
}

// CachedRepoPull is pull request number n of repo from the last list read,
// however old; nothing is sent. ok is false when no list was read or n is
// not in it: the PRs & CI tab acts only on a pull request it listed.
func (s *Service) CachedRepoPull(repo Repo, n int) (BranchPR, bool) {
	s.branchPulls.mu.Lock()
	defer s.branchPulls.mu.Unlock()
	for _, p := range s.branchPulls.m[repo.FullName()].list {
		if p.Number == n {
			return p, true
		}
	}
	return BranchPR{}, false
}
