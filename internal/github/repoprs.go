package github

import (
	"context"
	"net/http"
	"time"
)

// prCount is one repository's open pull request count and when it was read.
type prCount struct {
	at time.Time
	n  int
}

// OpenPullCount is how many pull requests are open in the GitHub repository
// remote names (a git remote URL), for a multi-repo project's page (ADR-055).
// Asked only when that page asks, never polled; one conditional GET of the
// open pulls (at most 100) per repository, kept for itemsTTL. ok is false
// with the reason when there is no count: not connected, not on GitHub, or
// GitHub's own error.
func (s *Service) OpenPullCount(ctx context.Context, remote string) (n int, ok bool, reason string) {
	s.init()
	repo, isGH := ParseRemote(remote)
	if !isGH {
		return 0, false, "not on GitHub"
	}
	if s.source() == "" {
		return 0, false, "GitHub is not connected"
	}
	key := repo.FullName()
	s.mu.Lock()
	if hit, found := s.openPRs[key]; found && s.Now().Sub(hit.at) < itemsTTL {
		s.mu.Unlock()
		return hit.n, true, ""
	}
	s.mu.Unlock()
	doing := "Counting the open pull requests of " + key
	res, e := s.call(ctx, request{method: http.MethodGet, path: repoPath(repo) + "/pulls?state=open&per_page=100", doing: doing})
	if e != nil {
		return 0, false, e.Error()
	}
	var open []apiPull
	if e := decode(res, doing, &open); e != nil {
		return 0, false, e.Error()
	}
	s.mu.Lock()
	if s.openPRs == nil || len(s.openPRs) >= maxCached {
		s.openPRs = map[string]prCount{}
	}
	s.openPRs[key] = prCount{at: s.Now(), n: len(open)}
	s.mu.Unlock()
	return len(open), true, ""
}
