package api

import (
	"context"
	"net/http"
	"sort"
	"time"

	"github.com/dspv/caprock/internal/github"
	"github.com/dspv/caprock/internal/store"
)

// ReposCI is GET /v1/repos/ci: the Now screen's CI/CD section
// (.ai/04-ui.md § CI/CD on Now). Owner, 2026-10-14, translated: "find a place
// on the dashboard for CI/CD indicators — costs, time, possible GitHub
// outages, or something stuck … but the core is the release: a team lead
// wants to understand where the money for tokens goes, how much each PR
// costs, who pushes there — literally face and name."
type ReposCI struct {
	GitHubConnected bool `json:"github_connected"`
	// Status is GitHub's own status page (githubstatus.com), only while
	// GitHub is connected.
	Status *github.GitHubStatus `json:"status,omitempty"`
	Repos  []RepoCIRow          `json:"repos"`
	// FetchedAt and Refreshing: as SessionPRs says them.
	FetchedAt  int64 `json:"fetched_at"`
	Refreshing bool  `json:"refreshing,omitempty"`
}

func (a ReposCI) stamped(at int64, refreshing bool) any {
	a.FetchedAt, a.Refreshing = at, refreshing
	return a
}

// RepoCIRow is one repository's CI, pull requests and agent spend.
type RepoCIRow struct {
	ProjectID int64  `json:"project_id"`
	Name      string `json:"name"`
	// Repo is owner/name on GitHub.
	Repo string `json:"repo"`
	// Live counts the sessions running in it.
	Live int `json:"live"`
	// CI is github.RunStats over its newest runs, 14 days.
	CI *github.CIStats `json:"ci,omitempty"`
	// Days are the local calendar days CI's series cover, oldest first.
	Days []string `json:"days,omitempty"`
	// Stuck are its runs going on far past their median, or queued long.
	Stuck []github.StuckRun `json:"stuck"`
	// Open counts its open pull requests, Merged7 those merged in 7 days.
	Open    int `json:"open"`
	Merged7 int `json:"merged_7d"`
	// TopPRs are the most expensive by agent cost (open, or merged in the
	// last 7 days), at most 5; Authors who opened those, by agent cost.
	TopPRs  []RepoCIPR     `json:"top_prs"`
	Authors []RepoCIAuthor `json:"authors"`
	// Release is its newest published release.
	Release *github.RepoRelease `json:"release,omitempty"`
	Error   *github.Error       `json:"error,omitempty"`
}

// RepoCIPR is one pull request with its agent cost.
type RepoCIPR struct {
	Number       int     `json:"number"`
	Title        string  `json:"title,omitempty"`
	URL          string  `json:"url"`
	State        string  `json:"state"`
	Draft        bool    `json:"draft,omitempty"`
	Author       string  `json:"author,omitempty"`
	AuthorAvatar string  `json:"author_avatar,omitempty"`
	CostUSD      float64 `json:"cost_usd"`
	Sessions     int     `json:"sessions"`
	Live         int     `json:"live"`
}

// RepoCIAuthor is one person who opened pull requests in the window.
type RepoCIAuthor struct {
	Login   string  `json:"login"`
	Avatar  string  `json:"avatar,omitempty"`
	PRs     int     `json:"prs"`
	Merged  int     `json:"merged"`
	CostUSD float64 `json:"cost_usd"`
}

// reposCIMax bounds the repositories read (each three kept GitHub lists).
const reposCIMax = 6

// reposCITop is how many pull requests the cost list keeps.
const reposCITop = 5

// handleReposCI answers the CI/CD section, which asks only while it is
// unfolded and the window visible. Each repository costs the kept reads the
// PRs & CI tab makes (its pull request list, its runs, its releases); the
// composed answer is kept as the deck's are (deckcache.go).
func (s *Server) handleReposCI(w http.ResponseWriter, r *http.Request) {
	if !s.requireProjects(w) {
		return
	}
	connected := s.githubConnected()
	s.serveDeck(w, r, deckKey("reposci", "", connected, 0), func(ctx context.Context) (deckAnswer, error) {
		return s.composeReposCI(ctx, connected)
	}, s.fail)
}

func (s *Server) composeReposCI(ctx context.Context, connected bool) (deckAnswer, error) {
	out := ReposCI{GitHubConnected: connected, Repos: []RepoCIRow{}}
	if !connected {
		return out, nil
	}
	if st, ok := s.d.GitHub.StatusPage(ctx); ok {
		out.Status = &st
	}
	ps, err := store.ListProjects(ctx, s.d.Store.DB(), false)
	if err != nil {
		return nil, err
	}
	sess, err := store.ListSessions(ctx, s.d.Store.DB(), true, store.MaxSessionsPage)
	if err != nil {
		return nil, err
	}
	now := time.Now()
	if s.d.GitHub.Now != nil {
		now = s.d.GitHub.Now()
	}
	type cand struct {
		row  RepoCIRow
		repo github.Repo
		root string
	}
	var withLive, idle []cand
	seen := map[string]bool{}
	for _, p := range ps {
		if p.Kind != store.ProjectKindRepo {
			continue
		}
		remote := p.RemoteURL
		if rc, ok := s.repos.get(ctx, p.Root); ok && rc.URL != "" {
			remote = rc.URL
		}
		repo, ok := github.ParseRemote(remote)
		if !ok || seen[repo.FullName()] {
			continue
		}
		seen[repo.FullName()] = true
		c := cand{row: RepoCIRow{ProjectID: p.ID, Name: p.Name, Repo: repo.FullName()}, repo: repo, root: p.Root}
		for _, x := range sess {
			dir := x.RepoRoot
			if dir == "" {
				dir = x.Cwd
			}
			if dir != "" && store.DirWithin(dir, p.Root) {
				c.row.Live++
			}
		}
		if c.row.Live > 0 {
			withLive = append(withLive, c)
		} else {
			idle = append(idle, c)
		}
	}
	for _, c := range append(withLive, idle...) {
		if len(out.Repos) >= reposCIMax {
			break
		}
		row, err := s.repoCIRow(ctx, c.row, c.repo, c.root, now)
		if err != nil {
			return nil, err
		}
		out.Repos = append(out.Repos, row)
	}
	return out, nil
}

// repoCIRow fills one repository's row from the kept GitHub reads and the
// recorded agent work. GitHub's refusal is part of the row.
func (s *Server) repoCIRow(ctx context.Context, row RepoCIRow, repo github.Repo, root string, now time.Time) (RepoCIRow, error) {
	row.Stuck, row.TopPRs, row.Authors = []github.StuckRun{}, []RepoCIPR{}, []RepoCIAuthor{}
	prs, e := s.d.GitHub.RepoPulls(ctx, repo)
	if e != nil {
		row.Error = e
		return row, nil
	}
	if runs, e := s.d.GitHub.RepoRuns(ctx, repo); e == nil {
		st := github.RunStats(runs, now, github.StatsDays)
		row.CI = &st
		row.Days = github.Stats(nil, nil, now, github.StatsDays).Days
		row.Stuck = github.StuckRuns(runs, now, github.StatsDays)
	} else {
		row.Error = e
	}
	if rels, e := s.d.GitHub.RepoReleases(ctx, repo); e == nil && len(rels) > 0 {
		row.Release = &rels[0]
	}
	week := now.AddDate(0, 0, -7).UnixMilli()
	var cands []github.BranchPR
	for _, p := range prs {
		switch {
		case p.State == "open":
			row.Open++
			cands = append(cands, p)
		case p.State == "merged" && p.MergedAt >= week:
			row.Merged7++
			cands = append(cands, p)
		}
	}
	spend, err := store.SpendByPR(ctx, s.d.Store.DB(), root, prRefs(cands))
	if err != nil {
		return row, err
	}
	authors := map[string]*RepoCIAuthor{}
	var order []string
	for _, p := range cands {
		sp := spend[p.URL]
		row.TopPRs = append(row.TopPRs, RepoCIPR{Number: p.Number, Title: p.Title, URL: p.URL, State: p.State, Draft: p.Draft,
			Author: p.Author, AuthorAvatar: p.AuthorAvatar, CostUSD: sp.CostUSD, Sessions: sp.Sessions, Live: sp.Live})
		if p.Author == "" {
			continue
		}
		a := authors[p.Author]
		if a == nil {
			a = &RepoCIAuthor{Login: p.Author, Avatar: p.AuthorAvatar}
			authors[p.Author] = a
			order = append(order, p.Author)
		}
		a.PRs++
		if p.State == "merged" {
			a.Merged++
		}
		a.CostUSD += sp.CostUSD
	}
	sort.SliceStable(row.TopPRs, func(a, b int) bool { return row.TopPRs[a].CostUSD > row.TopPRs[b].CostUSD })
	n := 0
	for n < len(row.TopPRs) && n < reposCITop && row.TopPRs[n].CostUSD > 0 {
		n++
	}
	row.TopPRs = row.TopPRs[:n]
	for _, l := range order {
		row.Authors = append(row.Authors, *authors[l])
	}
	sort.SliceStable(row.Authors, func(a, b int) bool {
		x, y := row.Authors[a], row.Authors[b]
		if x.CostUSD != y.CostUSD {
			return x.CostUSD > y.CostUSD
		}
		return x.PRs > y.PRs
	})
	return row, nil
}
