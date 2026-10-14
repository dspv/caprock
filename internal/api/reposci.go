package api

import (
	"context"
	"net/http"
	"sort"
	"strings"
	"sync"
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
	// Quiet are the listed GitHub repositories not read: no session in them
	// for RecentDays (unless `older` was asked), hidden by this viewer
	// (`hide`), or past the rows' bound. Nothing is sent to GitHub for them.
	Quiet []RepoCIQuiet `json:"quiet"`
	// RecentDays is the window of activity that lists a repository.
	RecentDays int `json:"recent_days"`
	deckFresh
}

func (a ReposCI) stamped(f deckFresh) any {
	a.deckFresh = f
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
	// LastActive is its newest session's last event, or when it was added
	// to the list if later (Unix ms; 0 when neither is known).
	LastActive int64 `json:"last_active,omitempty"`
	// Older says it is listed only because older repositories were asked.
	Older bool `json:"older,omitempty"`
	// Pending says GitHub's figures are being read: the quick answer, while
	// the first composition waits on GitHub.
	Pending bool `json:"pending,omitempty"`
	// Slow says GitHub did not answer within reposCIRepoTimeout; Error has
	// its words, and the next composition asks again.
	Slow bool `json:"slow,omitempty"`
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
	// ReadAt is when GitHub last answered its pull request list (unix ms):
	// with Error, the row draws on that older read, not refreshed.
	ReadAt int64 `json:"read_at,omitempty"`
}

// RepoCIQuiet is a listed GitHub repository the section does not read.
type RepoCIQuiet struct {
	ProjectID  int64  `json:"project_id"`
	Name       string `json:"name"`
	Repo       string `json:"repo"`
	LastActive int64  `json:"last_active,omitempty"`
	// Why: "older" (no activity in RecentDays), "hidden" (this viewer hid
	// it), "more" (past the bound on rows read).
	Why string `json:"why"`
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
	// Shared counts its sessions charged only in part (store.PRSpend).
	Shared int `json:"shared,omitempty"`
	// The tokens of the same work.
	TokensIn   int64 `json:"tokens_in"`
	TokensOut  int64 `json:"tokens_out"`
	CacheRead  int64 `json:"cache_read"`
	CacheWrite int64 `json:"cache_write"`
}

// RepoCIAuthor is one person who opened pull requests in the window.
type RepoCIAuthor struct {
	Login   string  `json:"login"`
	Avatar  string  `json:"avatar,omitempty"`
	PRs     int     `json:"prs"`
	Merged  int     `json:"merged"`
	CostUSD float64 `json:"cost_usd"`
}

// reposCIMax bounds the recent repositories read (each three kept GitHub
// lists); reposCIOlderMax all of them once older ones are asked.
const (
	reposCIMax      = 6
	reposCIOlderMax = 12
)

// reposCIRecentDays is the activity that lists a repository: a session in
// it, or its being added, within this many days (owner, 2026-10-14,
// translated: "why do I see projects from a hundred years ago?").
const reposCIRecentDays = 14

// reposCIParallel bounds the repositories read from GitHub at once, and
// reposCIRepoTimeout each one's reads. Read one after another under the
// composition's one deadline, a slow repository used to leave every one
// after it "could not reach GitHub: context deadline exceeded".
var reposCIRepoTimeout = 12 * time.Second // a variable for the tests

const (
	reposCIParallel = 3
	// reposCIComposeTimeout bounds a composition: two rounds of
	// reposCIParallel at reposCIRepoTimeout for reposCIMax repositories,
	// and some.
	reposCIComposeTimeout = 30 * time.Second
	// reposCIHideMax bounds the hidden repositories a request names.
	reposCIHideMax = 200
)

// reposCITop is how many pull requests the cost list keeps.
const reposCITop = 5

// reposCIAsk is what a request asks beyond the defaults: older repositories
// read too, and the repositories this viewer hid (owner/name, lower case).
type reposCIAsk struct {
	older bool
	hide  map[string]bool
}

func (a reposCIAsk) key() string {
	h := make([]string, 0, len(a.hide))
	for r := range a.hide {
		h = append(h, r)
	}
	sort.Strings(h)
	o := "0"
	if a.older {
		o = "1"
	}
	return o + ":" + strings.Join(h, ",")
}

func parseReposCIAsk(r *http.Request) reposCIAsk {
	q := r.URL.Query()
	a := reposCIAsk{older: q.Get("older") == "1", hide: map[string]bool{}}
	for _, h := range strings.Split(q.Get("hide"), ",") {
		h = strings.ToLower(strings.TrimSpace(h))
		if h != "" && strings.Count(h, "/") == 1 && len(a.hide) < reposCIHideMax {
			a.hide[h] = true
		}
	}
	return a
}

// handleReposCI answers the CI/CD section, which asks only while it is
// unfolded and the window visible. Each repository read costs the kept reads
// the PRs & CI tab makes (its pull request list, its runs, its releases);
// the composed answer is kept as the deck's are (deckcache.go). The first
// composition of a key, which waits on GitHub, is answered at once with the
// repositories and no figures (`pending`, `refreshing`).
func (s *Server) handleReposCI(w http.ResponseWriter, r *http.Request) {
	if !s.requireProjects(w) {
		return
	}
	connected := s.githubConnected()
	ask := parseReposCIAsk(r)
	s.serveDeckOrQuickWithin(w, r, deckKey("reposci", ask.key(), connected, 0), reposCIComposeTimeout, func(ctx context.Context) (deckAnswer, error) {
		return s.composeReposCI(ctx, connected, ask)
	}, func(ctx context.Context) (deckAnswer, error) {
		out, _, err := s.planReposCI(ctx, connected, ask)
		for i := range out.Repos {
			out.Repos[i].Pending = true
			out.Repos[i].Stuck, out.Repos[i].TopPRs, out.Repos[i].Authors = []github.StuckRun{}, []RepoCIPR{}, []RepoCIAuthor{}
		}
		return out, err
	}, s.fail)
}

// reposCIRead is a row to read from GitHub.
type reposCIRead struct {
	repo github.Repo
	root string
}

// planReposCI lists the rows and the quiet repositories without asking
// GitHub: the listed projects of kind repo on GitHub, one per repository,
// those with a session running first, then by last activity.
func (s *Server) planReposCI(ctx context.Context, connected bool, ask reposCIAsk) (ReposCI, []reposCIRead, error) {
	out := ReposCI{GitHubConnected: connected, Repos: []RepoCIRow{}, Quiet: []RepoCIQuiet{}, RecentDays: reposCIRecentDays}
	if !connected {
		return out, nil, nil
	}
	ps, err := store.ListProjects(ctx, s.d.Store.DB(), false)
	if err != nil {
		return out, nil, err
	}
	sess, err := store.ListSessions(ctx, s.d.Store.DB(), true, store.MaxSessionsPage)
	if err != nil {
		return out, nil, err
	}
	// Every directory sessions ran in, with its newest event: grouped by
	// SQLite, a few hundred rows.
	dirs, err := store.RecentDirs(ctx, s.d.Store.DB(), 1<<20)
	if err != nil {
		return out, nil, err
	}
	now := time.Now()
	if s.d.GitHub.Now != nil {
		now = s.d.GitHub.Now()
	}
	since := now.AddDate(0, 0, -reposCIRecentDays).UnixMilli()
	type cand struct {
		row  RepoCIRow
		read reposCIRead
	}
	var cands []cand
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
		c := cand{row: RepoCIRow{ProjectID: p.ID, Name: p.Name, Repo: repo.FullName(), LastActive: p.AddedAt}, read: reposCIRead{repo: repo, root: p.Root}}
		for _, x := range sess {
			dir := x.RepoRoot
			if dir == "" {
				dir = x.Cwd
			}
			if dir != "" && store.DirWithin(dir, p.Root) {
				c.row.Live++
			}
		}
		for _, d := range dirs {
			if d.LastEventAt > c.row.LastActive && store.DirWithin(d.Dir, p.Root) {
				c.row.LastActive = d.LastEventAt
			}
		}
		cands = append(cands, c)
	}
	sort.SliceStable(cands, func(a, b int) bool {
		x, y := cands[a].row, cands[b].row
		if (x.Live > 0) != (y.Live > 0) {
			return x.Live > 0
		}
		return x.LastActive > y.LastActive
	})
	var reads []reposCIRead
	quiet := func(r RepoCIRow, why string) {
		out.Quiet = append(out.Quiet, RepoCIQuiet{ProjectID: r.ProjectID, Name: r.Name, Repo: r.Repo, LastActive: r.LastActive, Why: why})
	}
	for _, c := range cands {
		recent := c.row.Live > 0 || c.row.LastActive >= since
		switch {
		case ask.hide[strings.ToLower(c.row.Repo)]:
			quiet(c.row, "hidden")
		case !recent && !ask.older:
			quiet(c.row, "older")
		case recent && len(reads) >= reposCIMax, len(reads) >= reposCIOlderMax:
			quiet(c.row, "more")
		default:
			c.row.Older = !recent
			out.Repos = append(out.Repos, c.row)
			reads = append(reads, c.read)
		}
	}
	return out, reads, nil
}

func (s *Server) composeReposCI(ctx context.Context, connected bool, ask reposCIAsk) (deckAnswer, error) {
	out, reads, err := s.planReposCI(ctx, connected, ask)
	if err != nil || !connected {
		return out, err
	}
	now := time.Now()
	if s.d.GitHub.Now != nil {
		now = s.d.GitHub.Now()
	}
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		if st, ok := s.d.GitHub.StatusPage(ctx); ok {
			out.Status = &st
		}
	}()
	errs := make([]error, len(reads))
	sem := make(chan struct{}, reposCIParallel)
	for i := range reads {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			gh, cancel := context.WithTimeout(ctx, reposCIRepoTimeout)
			defer cancel()
			out.Repos[i], errs[i] = s.repoCIRow(ctx, gh, out.Repos[i], reads[i].repo, reads[i].root, now)
		}(i)
	}
	wg.Wait()
	for _, e := range errs {
		if e != nil {
			return nil, e
		}
	}
	return out, nil
}

// slowGitHub says whether a GitHub refusal was its not answering in time:
// the row's own deadline, or the client's.
func slowGitHub(gh context.Context, e *github.Error) bool {
	if e == nil || e.Kind != github.KindNetwork {
		return false
	}
	m := strings.ToLower(e.Message)
	return gh.Err() != nil || strings.Contains(m, "deadline exceeded") || strings.Contains(m, "timeout")
}

// repoCIRow fills one repository's row from the kept GitHub reads, asked
// under gh, and the recorded agent work, read under ctx. GitHub's refusal is
// part of the row.
func (s *Server) repoCIRow(ctx, gh context.Context, row RepoCIRow, repo github.Repo, root string, now time.Time) (RepoCIRow, error) {
	row.Stuck, row.TopPRs, row.Authors = []github.StuckRun{}, []RepoCIPR{}, []RepoCIAuthor{}
	prs, e := s.d.GitHub.RepoPulls(gh, repo)
	if e != nil {
		// GitHub's refusal is the row's content, not a failure of the call.
		row.Error, row.Slow = e, slowGitHub(gh, e)
		return row, nil //nolint:nilerr // the error travels in row.Error
	}
	if runs, e := s.d.GitHub.RepoRuns(gh, repo); e == nil {
		st := github.RunStats(runs, now, github.StatsDays)
		row.CI = &st
		row.Days = github.Stats(nil, nil, now, github.StatsDays).Days
		row.Stuck = github.StuckRuns(runs, now, github.StatsDays)
	} else {
		row.Error, row.Slow = e, slowGitHub(gh, e)
	}
	if rels, e := s.d.GitHub.RepoReleases(gh, repo); e == nil && len(rels) > 0 {
		row.Release = &rels[0]
	}
	// A list handed back from an earlier read says so.
	at, failed := s.d.GitHub.RepoPullsRead(repo)
	row.ReadAt = at
	if failed != nil && row.Error == nil {
		row.Error = failed
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
			Author: p.Author, AuthorAvatar: p.AuthorAvatar, CostUSD: sp.CostUSD, Sessions: sp.Sessions, Live: sp.Live,
			Shared: sp.Shared, TokensIn: sp.TokensIn, TokensOut: sp.TokensOut, CacheRead: sp.CacheRead, CacheWrite: sp.CacheWrite})
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
