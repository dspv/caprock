package api

import (
	"context"
	"strings"
	"time"

	"github.com/dspv/caprock/internal/github"
	"github.com/dspv/caprock/internal/store"
)

// The Week's pull requests from GitHub's record where the daemon holds one
// (owner, 2026-10-25: the card said "5 PRs" in a week GitHub merged 59). For
// each repository the window's hand-run sessions worked in, mapped to its
// GitHub owner/name the way the Pipeline maps a session (repoCache, then
// github.ParseRemote), the pull requests merged and opened in the window come
// from github_prs; the transcripts' count stands only for a repository with
// no such record. Nothing is asked of GitHub here: github_prs holds the lists
// the Pipeline already read.

// PR sources a Week says its counts came from.
const (
	prsFromGitHub = "github" // github_prs, for every repository counted
	prsFromAgents = "agents" // the agents' own `gh pr` commands only
	prsFromBoth   = "both"   // GitHub where it was read, the agents' elsewhere
)

// weekPRs is the window's pull request counts, their source, and the cost
// per merged pull request.
type weekPRs struct {
	opened, merged int
	days           []int
	source         string
	// perMerged is absent (nil) with nothing merged or nothing spent.
	perMerged *float64
}

// slugOf is a repository root's GitHub owner/name, lower case, or "".
func (s *Server) slugOf(ctx context.Context, root string) string {
	r, ok := s.repos.get(ctx, root)
	if !ok || r.URL == "" {
		return ""
	}
	repo, ok := github.ParseRemote(r.URL)
	if !ok {
		return ""
	}
	return strings.ToLower(repo.FullName())
}

// countWeekPRs combines GitHub's record and the agents' own for wk.
//
// The cost per merged pull request, when GitHub's record has merges, is the
// mean of what the Pipeline charges each of them (store.KnownPRs, the figure
// its Most expensive list shows), so the card and the Pipeline never
// disagree; a pull request with no agent work recorded counts as $0. With
// the agents' count alone it is the window's cost over its merges, as before.
func (s *Server) countWeekPRs(ctx context.Context, wk store.Week, loc *time.Location) (weekPRs, error) {
	out := weekPRs{days: make([]int, len(wk.Days))}
	dayIdx := make(map[string]int, len(wk.Days))
	for i, d := range wk.Days {
		dayIdx[d.Day] = i
	}
	db := s.d.Store.DB()

	// The roots of each GitHub repository, dearest first (wk.Repos' order).
	var slugs []string
	rootOf := map[string]string{}
	for _, r := range wk.Repos {
		slug := s.slugOf(ctx, r.Root)
		if slug == "" {
			continue
		}
		if _, seen := rootOf[slug]; !seen {
			rootOf[slug] = r.Root
			slugs = append(slugs, slug)
		}
	}
	ghWin := map[string]store.GitHubWindow{}
	var spent float64
	ghMerged := 0
	for _, slug := range slugs {
		gw, err := store.GitHubPRsIn(ctx, db, slug, wk.FromMs, wk.ToMs)
		if err != nil {
			return out, err
		}
		if !gw.Known {
			continue
		}
		ghWin[slug] = gw
		out.merged += len(gw.Merged)
		out.opened += len(gw.OpenedAt)
		for _, at := range gw.OpenedAt {
			if i, ok := dayIdx[time.UnixMilli(at).In(loc).Format("2006-01-02")]; ok {
				out.days[i]++
			}
		}
		if len(gw.Merged) == 0 {
			continue
		}
		ghMerged += len(gw.Merged)
		known, err := store.KnownPRs(ctx, db, rootOf[slug], slug)
		if err != nil {
			return out, err
		}
		merged := make(map[int]bool, len(gw.Merged))
		for _, n := range gw.Merged {
			merged[n] = true
		}
		for _, p := range known {
			if merged[p.Number] {
				spent += p.Spend.CostUSD
			}
		}
	}

	// The agents' own count, for the repositories GitHub's record does not
	// cover. A merge by number in a directory no URL named carries the
	// directory; it is GitHub's when that directory is a known repository.
	agents := 0
	agentMerged := 0
	for _, p := range wk.AgentPRs {
		repo := strings.ToLower(p.Repo)
		if root, ok := strings.CutPrefix(p.Repo, "dir:"); ok {
			if slug := s.slugOf(ctx, root); slug != "" {
				repo = slug
			}
		}
		if _, covered := ghWin[repo]; covered {
			continue
		}
		if p.Opened {
			out.opened++
			agents++
			if p.Day >= 0 && p.Day < len(out.days) {
				out.days[p.Day]++
			}
		}
		if p.Merged {
			out.merged++
			agentMerged++
			agents++
		}
	}

	switch {
	case len(ghWin) > 0 && agents > 0:
		out.source = prsFromBoth
	case len(ghWin) > 0:
		out.source = prsFromGitHub
	case agents > 0:
		out.source = prsFromAgents
	}
	switch {
	case ghMerged > 0 && spent > 0:
		v := spent / float64(ghMerged)
		out.perMerged = &v
	case ghMerged == 0 && agentMerged > 0 && wk.CostUSD > 0:
		v := wk.CostUSD / float64(agentMerged)
		out.perMerged = &v
	}
	return out, nil
}
