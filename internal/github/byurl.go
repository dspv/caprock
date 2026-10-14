package github

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// How long one pull request read by its link is kept. A pull request whose
// checks are still running is asked about again soonest; one that settled
// less often; a merged or closed one hardly at all. Every read is a
// conditional request, so an unchanged answer costs GitHub's 304.
const (
	byURLPending = 20 * time.Second
	byURLOpen    = 2 * time.Minute
	byURLDone    = 30 * time.Minute
)

type byURLEntry struct {
	pr PR
	at time.Time
}

type byURLCache struct {
	mu sync.Mutex
	m  map[string]byURLEntry
}

// ParsePullURL reads a github.com pull request link:
// https://github.com/owner/name/pull/123.
func ParsePullURL(link string) (Repo, int, bool) {
	u, err := url.Parse(strings.TrimSpace(link))
	if err != nil || !strings.EqualFold(u.Hostname(), "github.com") {
		return Repo{}, 0, false
	}
	parts := strings.Split(strings.Trim(u.Path, "/"), "/")
	if len(parts) < 4 || parts[2] != "pull" || !namePart.MatchString(parts[0]) || !namePart.MatchString(parts[1]) {
		return Repo{}, 0, false
	}
	n, err := strconv.Atoi(parts[3])
	if err != nil || n <= 0 {
		return Repo{}, 0, false
	}
	return Repo{Owner: parts[0], Name: parts[1]}, n, true
}

// PullByURL is one pull request a session opened, by its link: its state,
// checks and review, read from GitHub and kept for a while (byURLPending,
// byURLOpen, byURLDone) so a deck polling it costs nothing between reads.
// Nothing is sent while GitHub is not connected.
func (s *Service) PullByURL(ctx context.Context, link string) (PR, *Error) {
	s.init()
	repo, number, ok := ParsePullURL(link)
	if !ok {
		return PR{}, errorf(KindInvalid, "Reading a pull request", "Not a github.com pull request link.")
	}
	now := s.Now()
	s.byURL.mu.Lock()
	if s.byURL.m == nil {
		s.byURL.m = map[string]byURLEntry{}
	}
	e, have := s.byURL.m[link]
	s.byURL.mu.Unlock()
	if have && now.Sub(e.at) < keepFor(e.pr) {
		return e.pr, nil
	}
	if s.source() == "" {
		return PR{}, errorf(KindNotConnected, "Reading a pull request", "GitHub is not connected.")
	}
	doing := fmt.Sprintf("Reading pull request #%d of %s", number, repo.FullName())
	res, ce := s.call(ctx, request{method: http.MethodGet, path: fmt.Sprintf("%s/pulls/%d", repoPath(repo), number), doing: doing})
	if ce != nil {
		if have {
			e.pr.Error = ce
			return e.pr, nil
		}
		return PR{}, ce
	}
	var p apiPull
	if de := decode(res, doing, &p); de != nil {
		if have {
			return e.pr, nil
		}
		return PR{}, de
	}
	pr := PR{Branch: p.Head.Ref, Repo: repo.FullName(), Number: p.Number, URL: p.HTMLURL, Title: p.Title, State: p.state(),
		Draft: p.Draft, Base: p.Base.Ref, HeadSHA: p.Head.SHA, CreatedAt: unixMS(p.CreatedAt), MergedAt: p.mergedMS(), Mergeable: p.Mergeable, MergeableState: p.MergeableState,
		AutoMerge: p.AutoMerge != nil, Reviews: []Review{}, Checks: Checks{State: "none", Items: []Check{}}, At: now.UnixMilli()}
	p.withSizes(&pr)
	if checks, _, ce := s.readChecks(ctx, repo, pr.HeadSHA); ce == nil {
		pr.Checks = checks
	} else if have {
		pr.Checks = e.pr.Checks
	}
	if reviews, _, re := s.readReviews(ctx, repo, pr.Number); re == nil {
		pr.Reviews = reviews
	} else if have {
		pr.Reviews = e.pr.Reviews
	}
	pr.Review = reviewState(pr.Reviews, len(p.RequestedReviewers) > 0)
	pr.Error = nil
	s.byURL.mu.Lock()
	s.byURL.m[link] = byURLEntry{pr: pr, at: now}
	s.byURL.mu.Unlock()
	return pr, nil
}

// CachedPull is the pull request last read by its link, however old, and
// when it was read; nothing is sent. ok is false when it was never read.
func (s *Service) CachedPull(link string) (pr PR, at time.Time, ok bool) {
	s.byURL.mu.Lock()
	defer s.byURL.mu.Unlock()
	e, ok := s.byURL.m[link]
	return e.pr, e.at, ok
}

func keepFor(pr PR) time.Duration {
	switch {
	case pr.State != "open":
		return byURLDone
	case pr.Checks.State == "pending":
		return byURLPending
	default:
		return byURLOpen
	}
}
