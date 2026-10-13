package github

import (
	"sort"
	"time"
)

// runsKeep is how long a runs list is reused: shorter while one of them is
// unfinished. A conditional read after it costs GitHub a 304 when nothing
// changed.
func runsKeep(runs []CIRun) time.Duration {
	for _, r := range runs {
		if r.Status != "" && r.Status != "completed" {
			return repoRunsActiveKept
		}
	}
	return repoRunsKept
}

// StuckRun is a run going on far longer than its workflow's runs usually
// take, or waiting for a runner longer than StuckQueued.
type StuckRun struct {
	ID     int64  `json:"id"`
	Name   string `json:"name"`
	Branch string `json:"branch,omitempty"`
	// Status is GitHub's: in_progress, else queued, waiting, pending or
	// requested (waiting for a runner).
	Status string `json:"status"`
	URL    string `json:"url,omitempty"`
	// Since is when it started, else when it was created (unix ms).
	Since int64 `json:"since"`
	// MedianMS is the workflow's median successful run; absent for a
	// queued one whose workflow has none.
	MedianMS int64 `json:"median_ms,omitempty"`
}

// StuckQueued is how long a run may wait for a runner before it is flagged.
const StuckQueued = 15 * time.Minute

// stuckOver is how far past its median a running run must also be: a
// two-minute workflow at five minutes is slow, not stuck.
const stuckOver = 10 * time.Minute

// StuckRuns lists the unfinished runs that look stuck: running for more
// than twice their workflow's median successful run over the days the
// figures cover and at least stuckOver past it (with no median, never), or
// waiting for a runner longer than StuckQueued. The longest first.
func StuckRuns(runs []CIRun, now time.Time, days int) []StuckRun {
	medians := map[string]int64{}
	for _, w := range RunStats(runs, now, days).Workflows {
		medians[w.Name] = w.MedianMS
	}
	out := []StuckRun{}
	at := now.UnixMilli()
	for _, r := range runs {
		if r.Status == "" || r.Status == "completed" {
			continue
		}
		since := r.StartedAt
		if since == 0 {
			since = r.CreatedAt
		}
		if since == 0 || since > at {
			continue
		}
		took := at - since
		m := medians[r.Name]
		var stuck bool
		if r.Status == "in_progress" {
			stuck = m > 0 && took > 2*m && took > m+stuckOver.Milliseconds()
		} else {
			stuck = took > StuckQueued.Milliseconds()
		}
		if !stuck {
			continue
		}
		out = append(out, StuckRun{ID: r.ID, Name: r.Name, Branch: r.HeadBranch, Status: r.Status, URL: r.HTMLURL, Since: since, MedianMS: m})
	}
	sort.SliceStable(out, func(a, b int) bool { return out[a].Since < out[b].Since })
	return out
}
