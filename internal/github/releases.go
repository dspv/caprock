package github

import (
	"context"
	"fmt"
	"net/http"
	"sync"
	"time"
)

// The PRs & CI board's Released column and its Releases panel (owner,
// 2026-10-14, translated: "essentially accounting of releases and
// commits-PRs"): the repository's newest published releases, one list read
// only while the board is shown, kept repoReleasesKept.
const (
	// repoReleasesRead is how many of the newest releases one read lists.
	repoReleasesRead = 10
	// repoReleasesKept is how long that list is reused: releases are hours
	// or days apart.
	repoReleasesKept = 10 * time.Minute
)

// RepoRelease is one published release.
type RepoRelease struct {
	Tag  string `json:"tag"`
	Name string `json:"name,omitempty"`
	URL  string `json:"url,omitempty"`
	// PublishedAt is GitHub's stamp (unix ms).
	PublishedAt int64 `json:"published_at"`
	Prerelease  bool  `json:"prerelease,omitempty"`
}

type releasesEntry struct {
	list []RepoRelease
	at   time.Time
}

type releasesCache struct {
	mu sync.Mutex
	m  map[string]releasesEntry
}

// RepoReleases is the repository's newest published releases, newest
// first (drafts and unpublished ones left out), from one
// GET /repos/{o}/{r}/releases?per_page=10, kept repoReleasesKept. A failed
// read keeps the last answer, if any. Nothing is sent while GitHub is not
// connected.
func (s *Service) RepoReleases(ctx context.Context, repo Repo) ([]RepoRelease, *Error) {
	s.init()
	doing := "Listing the releases of " + repo.FullName()
	if e := s.checkRepo(repo, doing); e != nil {
		return nil, e
	}
	key := repo.FullName()
	now := s.Now()
	s.releases.mu.Lock()
	if s.releases.m == nil {
		s.releases.m = map[string]releasesEntry{}
	}
	e, have := s.releases.m[key]
	s.releases.mu.Unlock()
	if have && now.Sub(e.at) < repoReleasesKept {
		return e.list, nil
	}
	if s.source() == "" {
		return nil, errorf(KindNotConnected, doing, "GitHub is not connected.")
	}
	res, ce := s.call(ctx, request{method: http.MethodGet, doing: doing, path: fmt.Sprintf("%s/releases?per_page=%d", repoPath(repo), repoReleasesRead)})
	if ce != nil {
		if have {
			return e.list, nil
		}
		return nil, ce
	}
	var raw []apiRelease
	if de := decode(res, doing, &raw); de != nil {
		if have {
			return e.list, nil
		}
		return nil, de
	}
	list := releasesFrom(raw)
	s.releases.mu.Lock()
	bound(s.releases.m, key, func(v releasesEntry) time.Time { return v.at })
	s.releases.m[key] = releasesEntry{list: list, at: now}
	s.releases.mu.Unlock()
	return list, nil
}

type apiRelease struct {
	TagName     string `json:"tag_name"`
	Name        string `json:"name"`
	HTMLURL     string `json:"html_url"`
	PublishedAt string `json:"published_at"`
	Draft       bool   `json:"draft"`
	Prerelease  bool   `json:"prerelease"`
}

// releasesFrom keeps the published releases, in GitHub's order (newest first).
func releasesFrom(raw []apiRelease) []RepoRelease {
	out := []RepoRelease{}
	for _, r := range raw {
		at := unixMS(r.PublishedAt)
		if r.Draft || at == 0 || r.TagName == "" {
			continue
		}
		rel := RepoRelease{Tag: r.TagName, URL: r.HTMLURL, PublishedAt: at, Prerelease: r.Prerelease}
		if r.Name != r.TagName {
			rel.Name = r.Name
		}
		out = append(out, rel)
	}
	return out
}

// CachedRepoReleases is the last list RepoReleases read, however old;
// nothing is sent. ok is false when none was read.
func (s *Service) CachedRepoReleases(repo Repo) ([]RepoRelease, bool) {
	s.releases.mu.Lock()
	defer s.releases.mu.Unlock()
	e, ok := s.releases.m[repo.FullName()]
	return e.list, ok
}
