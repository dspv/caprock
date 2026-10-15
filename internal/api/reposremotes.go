package api

import (
	"net/http"
	"sync"

	"github.com/dspv/caprock/internal/github"
)

// ReposRemotes is GET /v1/repos/remotes?dir=…&dir=…: which of the given
// folders are git repositories with a GitHub remote, and which repository
// that is. The Pipeline's repository picker lists only those (.ai/04-ui.md
// § Pipeline): a folder that is not a repository, or whose remote is not on
// GitHub, has no pull requests to show (owner, 2026-10-15, translated: two
// "caprock" entries, the second one "This folder is not a git repository
// with a remote").
type ReposRemotes struct {
	Repos []RepoRemote `json:"repos"`
}

// RepoRemote is one asked folder.
type RepoRemote struct {
	Dir string `json:"dir"`
	// Root is the repository's top level; absent when the folder is not in a
	// git repository.
	Root string `json:"root,omitempty"`
	// Repo is owner/name on GitHub; absent without a GitHub remote.
	Repo string `json:"repo,omitempty"`
	// Guarded is a folder macOS guards (Documents, Downloads…): this route
	// never runs git there, so it is not known either way.
	Guarded bool `json:"guarded,omitempty"`
}

// reposRemotesMax bounds the folders one request reads.
const reposRemotesMax = 100

func (s *Server) handleReposRemotes(w http.ResponseWriter, r *http.Request) {
	dirs := r.URL.Query()["dir"]
	seen := map[string]bool{}
	out := ReposRemotes{Repos: []RepoRemote{}}
	for _, d := range dirs {
		if d == "" || seen[d] || len(out.Repos) >= reposRemotesMax {
			continue
		}
		seen[d] = true
		out.Repos = append(out.Repos, RepoRemote{Dir: d})
	}
	ctx := r.Context()
	// Each folder is a few git processes on a cold cache (repoCache keeps the
	// answer a minute); read them side by side, at most 8 at once.
	var wg sync.WaitGroup
	sem := make(chan struct{}, 8)
	for i := range out.Repos {
		// No git in a folder macOS guards: opening the Pipeline must not ask
		// for Documents or Downloads.
		if protectedDir(out.Repos[i].Dir) {
			out.Repos[i].Guarded = true
			continue
		}
		wg.Add(1)
		go func(row *RepoRemote) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			rc, ok := s.repos.get(ctx, row.Dir)
			if !ok {
				return
			}
			row.Root = rc.Root
			if gh, ok := github.ParseRemote(rc.URL); ok {
				row.Repo = gh.FullName()
			}
		}(&out.Repos[i])
	}
	wg.Wait()
	writeJSON(w, http.StatusOK, out)
}
