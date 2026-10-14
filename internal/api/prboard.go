package api

import (
	"context"
	"sort"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/github"
	"github.com/dspv/caprock/internal/store"
)

// The PRs & CI tab's Board (owner, 2026-10-14, translated: "I want to see
// something like a KANBAN: how tasks come in, what stage they're in, maybe
// how many agents are working, even some costs, and how they move through
// stages — essentially accounting of releases and commits-PRs"). Composed
// from what the tab already reads — the repository's pull request list, its
// runs, the open pull requests' checks (the deck's kept reads) — plus its
// newest releases, and the sessions Caprock recorded on each pull request
// (store.SpendByPR). Nothing here is estimated but the release a merge
// shipped in, which is matched by time and labelled so.

// Board stages, in the order a pull request moves through them.
const (
	StageDraft    = "draft"
	StageOpen     = "open"  // open, its checks running (or not read)
	StageFix      = "fix"   // a red check, a conflict or changes requested
	StageReady    = "ready" // green or no checks: waiting for a review or a merge
	StageMerged   = "merged"
	StageReleased = "released"
)

// boardLivePRs is how many open pull requests' checks the board reads (the
// newest updated first): each is the deck's own kept read, four calls to
// GitHub when it has expired. boardLiveParallel of them are read at once:
// read one after another, a dozen open pull requests with running checks
// took longer than the composition's deadline on every refresh, so the board
// never got a new answer and froze on the last one (owner, 2026-10-14).
const (
	boardLivePRs      = 12
	boardLiveParallel = 4
)

// boardReleasesShown is how many releases the Releases panel lists.
const boardReleasesShown = 6

// PRBoard is the Board view's answer.
type PRBoard struct {
	Cards    []BoardCard    `json:"cards"`
	Releases []BoardRelease `json:"releases"`
	Flow     BoardFlow      `json:"flow"`
	// DefaultBranch is the branch a merge must land on to ship in a release.
	DefaultBranch string `json:"default_branch,omitempty"`
}

// BoardCard is one pull request on the board; its title, author and link are
// the prs entry with the same number.
type BoardCard struct {
	Number int    `json:"number"`
	Stage  string `json:"stage"`
	// StageAt is since when it is in the stage (unix ms): opened, its checks'
	// start or end, merged, released. Absent when not known.
	StageAt int64 `json:"stage_at,omitempty"`
	// CI is its head commit's checks: running | fail | pass | none; absent
	// when not read.
	CI string `json:"ci,omitempty"`
	// Why is what put it in fix: ci | conflict | changes_requested.
	Why    string `json:"why,omitempty"`
	Review string `json:"review,omitempty"`
	// Release is the tag it shipped in (released only).
	Release string `json:"release,omitempty"`
	// Spend is the agent work Caprock recorded for it (store.SpendByPR).
	Spend store.PRSpend `json:"spend"`
	// Stale says its checks are from an earlier read: this composition could
	// not read them again in time (or GitHub refused), so the card is drawn
	// as not re-confirmed.
	Stale bool `json:"stale,omitempty"`
}

// BoardRelease is one published release and the merges it shipped.
type BoardRelease struct {
	github.RepoRelease
	// PRs are the pull requests merged into the default branch after the
	// release before it was published and up to this one: matched by time,
	// from the listed pull requests.
	PRs      []int   `json:"prs"`
	CostUSD  float64 `json:"cost_usd"`
	Sessions int     `json:"sessions"`
	// Partial says the listed pull requests may not reach back to the
	// release before it, so some of its merges may be missing.
	Partial bool `json:"partial,omitempty"`
}

// BoardFlow is the strip above the board.
type BoardFlow struct {
	Counts map[string]int `json:"counts"`
	Days   int            `json:"days"`
	// Merged counts the merges in the window; TTMMedianMS is opened to
	// merged (github.TimeToMerge).
	Merged      int   `json:"merged"`
	TTMMedianMS int64 `json:"ttm_median_ms,omitempty"`
	TTMCount    int   `json:"ttm_count"`
	// ReleaseLagMedianMS is merged to released, over the window's released
	// cards: an estimate, the release matched by time. Absent with fewer
	// than two.
	ReleaseLagMedianMS int64 `json:"release_lag_median_ms,omitempty"`
	ReleaseLagCount    int   `json:"release_lag_count"`
	// CIMedianMS is the busiest workflow's median successful run.
	CIMedianMS int64 `json:"ci_median_ms,omitempty"`
	// CostUSD sums the cards' agent cost.
	CostUSD float64 `json:"cost_usd"`
}

// boardInput is what a board is built from.
type boardInput struct {
	prs  []github.BranchPR
	live map[int]github.PR
	// stale are the open pull requests whose live read is an earlier one.
	stale         map[int]bool
	runs          []github.CIRun
	releases      []github.RepoRelease
	defaultBranch string
	spend         map[string]store.PRSpend
	now           time.Time
	days          int
	// listedAll says the pull request list is shorter than a page: every
	// pull request of the repository is in it.
	listedAll bool
}

// buildBoard lays the pull requests out by stage. Closed unmerged ones are
// left out, and so are merges before the window.
func buildBoard(in boardInput) PRBoard {
	out := PRBoard{Cards: []BoardCard{}, Releases: []BoardRelease{}, DefaultBranch: in.defaultBranch,
		Flow: BoardFlow{Counts: map[string]int{StageDraft: 0, StageOpen: 0, StageFix: 0, StageReady: 0, StageMerged: 0, StageReleased: 0}, Days: in.days}}
	start := time.Date(in.now.Year(), in.now.Month(), in.now.Day(), 0, 0, 0, 0, in.now.Location()).AddDate(0, 0, -(in.days - 1)).UnixMilli()
	// Releases oldest first, for "the first published after the merge".
	rels := append([]github.RepoRelease(nil), in.releases...)
	sort.SliceStable(rels, func(a, b int) bool { return rels[a].PublishedAt < rels[b].PublishedAt })
	shippedIn := func(p github.BranchPR) *github.RepoRelease {
		if p.MergedAt == 0 || (in.defaultBranch != "" && p.Base != in.defaultBranch) {
			return nil
		}
		for i := range rels {
			if rels[i].PublishedAt >= p.MergedAt {
				return &rels[i]
			}
		}
		return nil
	}
	byTag := map[string]*BoardRelease{}
	var lags []int64
	for _, p := range in.prs {
		c := BoardCard{Number: p.Number, Spend: in.spend[p.URL]}
		if c.Spend.Agents == nil {
			c.Spend.Agents = []string{}
		}
		// A pull request read on its own just now, merged or closed since the
		// list was read, leaves the open stages at once.
		if live, ok := in.live[p.Number]; ok && p.State == "open" && !in.stale[p.Number] && live.State != "" && live.State != "open" {
			p.State = live.State
			if p.MergedAt == 0 {
				p.MergedAt = live.MergedAt
			}
		}
		switch p.State {
		case "merged":
			rel := shippedIn(p)
			if rel != nil {
				b := byTag[rel.Tag]
				if b == nil {
					b = &BoardRelease{RepoRelease: *rel, PRs: []int{}}
					byTag[rel.Tag] = b
				}
				b.PRs = append(b.PRs, p.Number)
				b.CostUSD += c.Spend.CostUSD
				b.Sessions += c.Spend.Sessions
			}
			if p.MergedAt < start {
				continue
			}
			c.Stage, c.StageAt = StageMerged, p.MergedAt
			if rel != nil {
				c.Stage, c.StageAt, c.Release = StageReleased, rel.PublishedAt, rel.Tag
				lags = append(lags, rel.PublishedAt-p.MergedAt)
			}
		case "open":
			c.Stage, c.StageAt = openStage(p, in.live[p.Number], in.runs, &c)
			c.Stale = in.stale[p.Number]
		default:
			continue
		}
		out.Flow.Counts[c.Stage]++
		out.Flow.CostUSD += c.Spend.CostUSD
		out.Cards = append(out.Cards, c)
	}
	// Waiting stages longest-waiting first; merges newest first.
	rank := map[string]int{StageDraft: 0, StageOpen: 1, StageFix: 2, StageReady: 3, StageMerged: 4, StageReleased: 5}
	sort.SliceStable(out.Cards, func(a, b int) bool {
		x, y := out.Cards[a], out.Cards[b]
		if x.Stage != y.Stage {
			return rank[x.Stage] < rank[y.Stage]
		}
		if x.Stage == StageMerged || x.Stage == StageReleased {
			return x.StageAt > y.StageAt
		}
		return x.StageAt < y.StageAt
	})

	// The releases, newest first; the oldest shown is partial when the list
	// may not reach back to the release before it.
	var oldestListed int64
	for _, p := range in.prs {
		if p.CreatedAt > 0 && (oldestListed == 0 || p.CreatedAt < oldestListed) {
			oldestListed = p.CreatedAt
		}
	}
	for i := len(rels) - 1; i >= 0 && len(out.Releases) < boardReleasesShown; i-- {
		b := byTag[rels[i].Tag]
		if b == nil {
			b = &BoardRelease{RepoRelease: rels[i], PRs: []int{}}
		}
		var prev int64
		if i > 0 {
			prev = rels[i-1].PublishedAt
		}
		b.Partial = !in.listedAll && (prev == 0 || prev < oldestListed)
		out.Releases = append(out.Releases, *b)
	}

	out.Flow.Merged = sumInts(github.MergesPerDay(in.prs, in.now, in.days))
	out.Flow.TTMMedianMS, out.Flow.TTMCount = github.TimeToMerge(in.prs, in.now, in.days)
	out.Flow.ReleaseLagMedianMS, out.Flow.ReleaseLagCount = medianMS(lags), len(lags)
	if st := github.RunStats(in.runs, in.now, in.days); len(st.Workflows) > 0 {
		out.Flow.CIMedianMS = st.Workflows[0].MedianMS
	}
	return out
}

// openStage is an open pull request's stage and since when, from its
// checks as the deck read them, else from the repository's runs list.
func openStage(p github.BranchPR, live github.PR, runs []github.CIRun, c *BoardCard) (string, int64) {
	if p.Draft {
		return StageDraft, p.CreatedAt
	}
	ci, from, to := "", int64(0), int64(0)
	if live.Number != 0 {
		switch live.Checks.State {
		case "pending":
			ci = "running"
		case "fail":
			ci = "fail"
		case "pass":
			ci = "pass"
		case "none":
			ci = "none"
		}
		for _, k := range live.Checks.Items {
			if k.StartedAt > 0 && (from == 0 || k.StartedAt < from) {
				from = k.StartedAt
			}
			to = max(to, k.CompletedAt)
		}
		c.Review = live.Review
	} else if p.HeadSHA != "" {
		ci, from, to = runsState(p.HeadSHA, runs)
	}
	c.CI = ci
	conflict := live.Number != 0 && ((live.Mergeable != nil && !*live.Mergeable) || live.MergeableState == "dirty")
	switch {
	case ci == "fail":
		c.Why = "ci"
	case conflict:
		c.Why = "conflict"
	case c.Review == "changes_requested":
		c.Why = "changes_requested"
	}
	since := func(t int64) int64 {
		if t > 0 {
			return t
		}
		return p.CreatedAt
	}
	switch {
	case c.Why != "":
		return StageFix, since(to)
	case ci == "running":
		return StageOpen, since(from)
	case ci == "pass" || ci == "none":
		return StageReady, since(to)
	}
	return StageOpen, p.CreatedAt
}

// runsState is a head commit's state from the runs list: running while one
// is unfinished, fail when one failed, pass when one passed; "" when the
// list has none of its runs (it holds the newest 100 only).
func runsState(sha string, runs []github.CIRun) (state string, from, to int64) {
	var running, failed, passed bool
	for _, r := range runs {
		if r.HeadSHA != sha {
			continue
		}
		if r.Status != "completed" {
			running = true
			if t := r.StartedAt; t > 0 && (from == 0 || t < from) {
				from = t
			}
			continue
		}
		to = max(to, r.UpdatedAt)
		switch r.Conclusion {
		case "failure", "timed_out", "startup_failure":
			failed = true
		case "success":
			passed = true
		}
	}
	switch {
	case running:
		return "running", from, to
	case failed:
		return "fail", from, to
	case passed:
		return "pass", from, to
	}
	return "", 0, 0
}

func sumInts(xs []int) int {
	n := 0
	for _, x := range xs {
		n += x
	}
	return n
}

// medianMS is the median of xs, 0 with fewer than two (rule 6).
func medianMS(xs []int64) int64 {
	if len(xs) < 2 {
		return 0
	}
	s := append([]int64(nil), xs...)
	sort.Slice(s, func(a, b int) bool { return s[a] < s[b] })
	if n := len(s); n%2 == 1 {
		return s[n/2]
	}
	return (s[len(s)/2-1] + s[len(s)/2]) / 2
}

// prRefs is the pull requests as SpendByPR takes them: for a head branch two
// share, the open one first, then the most recently updated (prs' order).
func prRefs(prs []github.BranchPR) []store.PRRef {
	out := make([]store.PRRef, 0, len(prs))
	for _, p := range prs {
		if p.State == "open" {
			out = append(out, store.PRRef{URL: p.URL, Branch: p.Head})
		}
	}
	for _, p := range prs {
		if p.State != "open" {
			out = append(out, store.PRRef{URL: p.URL, Branch: p.Head})
		}
	}
	return out
}

// composeBoard reads what the board needs beyond the tab's own list and
// runs: the newest releases, the open pull requests' checks and the
// recorded agent work. GitHub is asked under gh, the store under ctx, so a
// slow GitHub leaves cards marked stale instead of failing the whole answer.
// A failed release list is no releases, not an error.
func (s *Server) composeBoard(ctx, gh context.Context, repo github.Repo, repoRoot, localDefault string, prs []github.BranchPR, runs []github.CIRun, now time.Time) (*PRBoard, error) {
	in := boardInput{prs: prs, runs: runs, now: now, days: github.StatsDays, live: map[int]github.PR{}, stale: map[int]bool{}, listedAll: len(prs) < 50}
	if rels, e := s.d.GitHub.RepoReleases(gh, repo); e == nil {
		in.releases = rels
	}
	if def, e := s.defaultBranch(gh, repo, localDefault); e == nil {
		in.defaultBranch = def
	}
	var open []github.BranchPR
	for _, p := range prs {
		if p.State == "open" && len(open) < boardLivePRs {
			open = append(open, p)
		}
	}
	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, boardLiveParallel)
	for _, p := range open {
		wg.Add(1)
		go func(p github.BranchPR) {
			defer wg.Done()
			var live github.PR
			var stale bool
			select {
			case sem <- struct{}{}:
				var e *github.Error
				live, e = s.d.GitHub.PullByURL(gh, p.URL)
				<-sem
				// PullByURL hands back its last good read with the refusal
				// beside it when the read fails.
				stale = e != nil || live.Error != nil
				if e != nil {
					live = github.PR{}
				}
			case <-gh.Done():
				stale = true
			}
			if live.Number == 0 {
				if c, _, ok := s.d.GitHub.CachedPull(p.URL); ok {
					live = c
				}
			}
			mu.Lock()
			defer mu.Unlock()
			if live.Number != 0 {
				in.live[p.Number] = live
			}
			if stale {
				in.stale[p.Number] = true
			}
		}(p)
	}
	wg.Wait()
	spend, err := store.SpendByPR(ctx, s.d.Store.DB(), repoRoot, prRefs(prs))
	if err != nil {
		return nil, err
	}
	in.spend = spend
	b := buildBoard(in)
	return &b, nil
}
