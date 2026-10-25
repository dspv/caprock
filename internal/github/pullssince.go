package github

import (
	"context"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// The share card counts a period's pull requests from github_prs, which
// holds the lists the Pipeline read: its newest 50 at a time, from the day
// the table was made. A period reaching past that read short of GitHub
// (owner, 2026-10-25: the card said 48 merged in a week GitHub merged 59), so
// the missing older part is read once, page by page.
const (
	// pullsSincePage is the pull requests asked for a page: GitHub's most.
	pullsSincePage = 100
	// PullsSinceMaxPages bounds one read: 1,000 pull requests updated in the
	// period. A period busier than that is read as far as it goes and said
	// to be incomplete.
	PullsSinceMaxPages = 10
)

// PullsSince is every pull request of repo updated at or after since (unix
// ms), most recently updated first, read page by page until one reaches past
// since or maxPages were read (at most PullsSinceMaxPages). A pull request
// merged or opened in the period was updated in it, so the list holds them
// all; complete says the read reached since. A fork's pull request is kept,
// it is this repository's all the same, with no Head: its branch is the
// fork's, never one of this repository's to charge sessions by. Nothing is
// sent while GitHub is not connected.
func (s *Service) PullsSince(ctx context.Context, repo Repo, since int64, maxPages int) (prs []BranchPR, complete bool, e *Error) {
	s.init()
	if s.source() == "" {
		return nil, false, errorf(KindNotConnected, "Listing pull requests", "GitHub is not connected.")
	}
	if maxPages <= 0 || maxPages > PullsSinceMaxPages {
		maxPages = PullsSinceMaxPages
	}
	doing := "Listing the older pull requests of " + repo.FullName()
	for page := 1; page <= maxPages; page++ {
		v := url.Values{"state": {"all"}, "sort": {"updated"}, "direction": {"desc"},
			"per_page": {strconv.Itoa(pullsSincePage)}, "page": {strconv.Itoa(page)}}
		res, ce := s.call(ctx, request{method: http.MethodGet, path: repoPath(repo) + "/pulls?" + v.Encode(), doing: doing})
		if ce != nil {
			return prs, false, ce
		}
		var list []apiPull
		if ce = decode(res, doing, &list); ce != nil {
			return prs, false, ce
		}
		for _, p := range list {
			pr := sincePull(repo, p)
			if pr.UpdatedAt != 0 && pr.UpdatedAt < since {
				return prs, true, nil
			}
			prs = append(prs, pr)
		}
		if len(list) < pullsSincePage {
			return prs, true, nil
		}
	}
	return prs, false, nil
}

// sincePull is p as the header github_prs keeps; a fork's has no Head.
func sincePull(repo Repo, p apiPull) BranchPR {
	pr := BranchPR{Number: p.Number, URL: p.HTMLURL, Title: p.Title, State: p.state(), Draft: p.Draft,
		Base: p.Base.Ref, HeadSHA: p.Head.SHA, CreatedAt: unixMS(p.CreatedAt), MergedAt: p.mergedMS(), Head: p.Head.Ref}
	if p.Head.Repo != nil && !strings.EqualFold(p.Head.Repo.FullName, repo.FullName()) {
		pr.Head = ""
	}
	if p.ClosedAt != nil {
		pr.ClosedAt = unixMS(*p.ClosedAt)
	}
	if p.UpdatedAt != "" {
		pr.UpdatedAt = unixMS(p.UpdatedAt)
	}
	return pr
}
