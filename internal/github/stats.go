package github

import (
	"context"
	"fmt"
	"sort"
	"sync"
	"time"
)

// The PRs & CI tab's figures over time (.ai/21-app.md § PRs & CI tab): how
// many pull requests were merged each day, how long they took to merge, and
// what the repository's GitHub Actions runs did — red, re-run, how long.
// Counted from what GitHub returned, with its own stamps; nothing estimated.
// The pull requests come from the list PullsByBranch already reads; the runs
// from one more list, asked only while the tab is shown and kept repoRunsKept.

const (
	// repoRunsRead is how many of a repository's newest runs one read lists.
	repoRunsRead = 100
	// repoRunsKept is how long that list is reused: the figures are about
	// days, not minutes.
	repoRunsKept = 30 * time.Minute
	// StatsDays is how many days the series cover, today the last.
	StatsDays = 14
)

type repoRunsEntry struct {
	runs []CIRun
	at   time.Time
}

type repoRunsCache struct {
	mu sync.Mutex
	m  map[string]repoRunsEntry
}

// RepoRuns is the repository's newest workflow runs (every workflow and
// event, at most repoRunsRead, without their jobs), kept repoRunsKept. A
// failed read keeps the last answer, if any. Nothing is sent while GitHub is
// not connected.
func (s *Service) RepoRuns(ctx context.Context, repo Repo) ([]CIRun, *Error) {
	s.init()
	doing := "Listing the workflow runs of " + repo.FullName()
	if e := s.checkRepo(repo, doing); e != nil {
		return nil, e
	}
	key := repo.FullName()
	now := s.Now()
	s.repoRuns.mu.Lock()
	if s.repoRuns.m == nil {
		s.repoRuns.m = map[string]repoRunsEntry{}
	}
	e, have := s.repoRuns.m[key]
	s.repoRuns.mu.Unlock()
	if have && now.Sub(e.at) < repoRunsKept {
		return e.runs, nil
	}
	if s.source() == "" {
		return nil, errorf(KindNotConnected, doing, "GitHub is not connected.")
	}
	list, ce := s.listRuns(ctx, fmt.Sprintf("%s/actions/runs?per_page=%d", repoPath(repo), repoRunsRead), doing)
	if ce != nil {
		if have {
			return e.runs, nil
		}
		return nil, ce
	}
	runs := make([]CIRun, len(list))
	for i, ar := range list {
		runs[i] = ar.run()
	}
	s.repoRuns.mu.Lock()
	bound(s.repoRuns.m, key, func(v repoRunsEntry) time.Time { return v.at })
	s.repoRuns.m[key] = repoRunsEntry{runs: runs, at: now}
	s.repoRuns.mu.Unlock()
	return runs, nil
}

// CachedRepoRuns is the last list RepoRuns read, however old; nothing is
// sent. ok is false when none was read.
func (s *Service) CachedRepoRuns(repo Repo) ([]CIRun, bool) {
	s.repoRuns.mu.Lock()
	defer s.repoRuns.mu.Unlock()
	e, ok := s.repoRuns.m[repo.FullName()]
	return e.runs, ok
}

// RepoStats is a repository's figures over the last StatsDays days.
type RepoStats struct {
	// Days are the local calendar days covered, oldest first, "2006-01-02".
	Days []string `json:"days"`
	// Merged counts the pull requests merged each day.
	Merged []int `json:"merged"`
	// TTMMedianMS is the median time from opened to merged of the pull
	// requests merged in the window; TTMCount how many it is the median of.
	TTMMedianMS int64 `json:"ttm_median_ms,omitempty"`
	TTMCount    int   `json:"ttm_count"`
	// PRsListed is how many pull requests the counts are read from: the
	// newest updated, so a busy repository's oldest days may be short.
	PRsListed int     `json:"prs_listed"`
	CI        CIStats `json:"ci"`
}

// CIStats is what the repository's runs in the window did.
type CIStats struct {
	// Runs counts the finished runs that passed or failed; Red those that
	// failed (failure, timed out, could not start). Cancelled and skipped
	// runs are neither.
	Runs int `json:"runs"`
	Red  int `json:"red"`
	// Reruns counts the runs on an attempt past the first.
	Reruns int `json:"reruns"`
	// Listed is how many runs were read, and Oldest the oldest one's start
	// (unix ms): a busy repository's 100 runs may not reach back to the
	// window's first day.
	Listed int   `json:"listed"`
	Oldest int64 `json:"oldest,omitempty"`
	// PerDay is the same counts per day, oldest first.
	PerDay []CIDay `json:"per_day"`
	// Workflows are each workflow's figures, the one with the most runner
	// wall-clock time first: the one that holds a merge up.
	Workflows []WorkflowStats `json:"workflows"`
}

// CIDay is one day's runs.
type CIDay struct {
	Runs int `json:"runs"`
	Red  int `json:"red"`
}

// WorkflowStats is one workflow's runs in the window.
type WorkflowStats struct {
	Name string `json:"name"`
	Runs int    `json:"runs"`
	Red  int    `json:"red"`
	// MedianMS is the median wall-clock time (run started to last updated)
	// of its successful runs, and MedianRuns how many; with fewer than two
	// there is no median.
	MedianMS   int64 `json:"median_ms,omitempty"`
	MedianRuns int   `json:"median_runs"`
	// DailyMedianMS is the same median per day, 0 for a day without two
	// successful runs.
	DailyMedianMS []int64 `json:"daily_median_ms"`
}

// red says whether a finished run counts as red; ok is false for one that
// is neither red nor green (cancelled, skipped, neutral, still running).
func red(r CIRun) (isRed, ok bool) {
	if r.Status != "completed" {
		return false, false
	}
	switch r.Conclusion {
	case "success":
		return false, true
	case "failure", "timed_out", "startup_failure":
		return true, true
	}
	return false, false
}

// dayIndex is which of the window's days t falls on, -1 when outside it.
func dayIndex(t int64, start time.Time, days int) int {
	if t == 0 {
		return -1
	}
	at := time.UnixMilli(t).In(start.Location())
	if at.Before(start) {
		return -1
	}
	d := int(at.Sub(start) / (24 * time.Hour))
	// A day with a clock change is 23 or 25 hours: count by the calendar.
	for d > 0 && at.Before(start.AddDate(0, 0, d)) {
		d--
	}
	for d+1 < days && !at.Before(start.AddDate(0, 0, d+1)) {
		d++
	}
	if d >= days {
		return -1
	}
	return d
}

// windowStart is the first day's midnight, in now's location.
func windowStart(now time.Time, days int) time.Time {
	y, m, d := now.Date()
	return time.Date(y, m, d, 0, 0, 0, 0, now.Location()).AddDate(0, 0, -(days - 1))
}

// MergesPerDay counts the pull requests merged on each of the days days
// ending today (now's location), oldest first.
func MergesPerDay(prs []BranchPR, now time.Time, days int) []int {
	out := make([]int, days)
	start := windowStart(now, days)
	for _, p := range prs {
		if i := dayIndex(p.MergedAt, start, days); i >= 0 && p.State == "merged" {
			out[i]++
		}
	}
	return out
}

// TimeToMerge is the median time from opened to merged of the pull requests
// merged in the days days ending today, and how many there were.
func TimeToMerge(prs []BranchPR, now time.Time, days int) (int64, int) {
	start := windowStart(now, days)
	var spans []int64
	for _, p := range prs {
		if p.State != "merged" || p.CreatedAt == 0 || p.MergedAt < p.CreatedAt || dayIndex(p.MergedAt, start, days) < 0 {
			continue
		}
		spans = append(spans, p.MergedAt-p.CreatedAt)
	}
	return median(spans), len(spans)
}

// RunStats sums the runs started in the days days ending today.
func RunStats(runs []CIRun, now time.Time, days int) CIStats {
	start := windowStart(now, days)
	out := CIStats{Listed: len(runs), PerDay: make([]CIDay, days), Workflows: []WorkflowStats{}}
	type wf struct {
		w     WorkflowStats
		total int64
		all   []int64
		daily [][]int64
	}
	byName := map[string]*wf{}
	var order []string
	for _, r := range runs {
		begin := r.StartedAt
		if begin == 0 {
			begin = r.CreatedAt
		}
		if begin != 0 && (out.Oldest == 0 || begin < out.Oldest) {
			out.Oldest = begin
		}
		i := dayIndex(begin, start, days)
		if i < 0 {
			continue
		}
		isRed, ok := red(r)
		if !ok {
			continue
		}
		if r.Attempt > 1 {
			out.Reruns++
		}
		out.Runs++
		out.PerDay[i].Runs++
		w := byName[r.Name]
		if w == nil {
			w = &wf{w: WorkflowStats{Name: r.Name}, daily: make([][]int64, days)}
			byName[r.Name] = w
			order = append(order, r.Name)
		}
		w.w.Runs++
		if isRed {
			out.Red++
			out.PerDay[i].Red++
			w.w.Red++
			continue
		}
		if span := r.UpdatedAt - r.StartedAt; r.StartedAt > 0 && span > 0 {
			w.all = append(w.all, span)
			w.daily[i] = append(w.daily[i], span)
			w.total += span
		}
	}
	list := make([]*wf, 0, len(order))
	for _, n := range order {
		list = append(list, byName[n])
	}
	sort.SliceStable(list, func(a, b int) bool { return list[a].total > list[b].total })
	for _, w := range list {
		w.w.MedianMS, w.w.MedianRuns = median(w.all), len(w.all)
		w.w.DailyMedianMS = make([]int64, days)
		for i, d := range w.daily {
			w.w.DailyMedianMS[i] = median(d)
		}
		out.Workflows = append(out.Workflows, w.w)
	}
	return out
}

// Stats puts a repository's figures together.
func Stats(prs []BranchPR, runs []CIRun, now time.Time, days int) RepoStats {
	start := windowStart(now, days)
	out := RepoStats{Days: make([]string, days), Merged: MergesPerDay(prs, now, days), PRsListed: len(prs), CI: RunStats(runs, now, days)}
	for i := range out.Days {
		out.Days[i] = start.AddDate(0, 0, i).Format("2006-01-02")
	}
	out.TTMMedianMS, out.TTMCount = TimeToMerge(prs, now, days)
	return out
}

// median of xs; 0 with fewer than two (rule 6: one run is no median).
func median(xs []int64) int64 {
	if len(xs) < 2 {
		return 0
	}
	s := append([]int64(nil), xs...)
	sort.Slice(s, func(a, b int) bool { return s[a] < s[b] })
	n := len(s)
	if n%2 == 1 {
		return s[n/2]
	}
	return (s[n/2-1] + s[n/2]) / 2
}

// CachedRepoPulls is the last list of the repository's own pull requests
// read for the Branches view or the PRs & CI tab, however old; nothing is
// sent. ok is false when none was read.
func (s *Service) CachedRepoPulls(repo Repo) ([]BranchPR, bool) {
	s.branchPulls.mu.Lock()
	defer s.branchPulls.mu.Unlock()
	e, ok := s.branchPulls.m[repo.FullName()]
	if !ok {
		return nil, false
	}
	return append([]BranchPR(nil), e.list...), true
}

// CachedRelease is the last release answer the deck's Release view read,
// however old; nothing is sent. ok is false when none was read.
func (s *Service) CachedRelease(repo Repo) (ReleaseCI, bool) {
	s.repoCI.mu.Lock()
	defer s.repoCI.mu.Unlock()
	e, ok := s.repoCI.release[repo.FullName()]
	return e.rel, ok
}
