package api

import (
	"sort"
	"time"

	"github.com/dspv/caprock/internal/github"
)

// The Pipeline's figures in dynamics (owner, 2026-10-15, translated: "I
// want the figures in dynamics, like everywhere else in our app — the
// metric, plus a small chart, and above/below the average indicator"):
// each figure that has a history gets one point per local calendar day of
// the window, today last, from what the board already read — the pull
// request list's stamps, the runs list, the releases. Nothing is asked of
// GitHub for it.
//
// Needs a fix and Ready have no series: whether a pull request was red or
// green on a past day is not in anything read (a check's state is its
// head commit's now).

// The series' keys: the figure each one belongs to (FlowFigures' keys).
const (
	SeriesFlight     = "flight"
	SeriesThroughput = "throughput"
	SeriesCI         = "ci"
	SeriesTTM        = "ttm"
	SeriesLag        = "lag"
	SeriesCost       = "cost"
)

// FlowPoint is one day of a figure's series.
type FlowPoint struct {
	// Day is the local calendar day, "2006-01-02".
	Day string `json:"day"`
	// Value is the day's figure: a count, a median in ms, dollars. Absent on
	// a day with no sample for a median — a gap, never a zero.
	Value *float64 `json:"value,omitempty"`
	// N is how many samples the value rests on: the merges, runs, released
	// merges or open pull requests counted.
	N int `json:"n"`
	// ByNow is a running total's value up to the clock time it is now
	// (throughput, cost), so today so far can be set against earlier days
	// at the same hour rather than against whole days.
	ByNow *float64 `json:"by_now,omitempty"`
}

func f64(v float64) *float64 { return &v }

// medianOf is the median of xs, any count from one; ok false with none. A
// day's median of one sample is that sample, its N saying how thin it is;
// the figures' own 14-day medians keep their two-sample floor (medianMS).
func medianOf(xs []int64) (float64, bool) {
	if len(xs) == 0 {
		return 0, false
	}
	s := append([]int64(nil), xs...)
	sort.Slice(s, func(a, b int) bool { return s[a] < s[b] })
	n := len(s)
	if n%2 == 1 {
		return float64(s[n/2]), true
	}
	return float64(s[n/2-1]+s[n/2]) / 2, true
}

// clockOf is how far into its local day t is.
func clockOf(t time.Time) time.Duration {
	y, m, d := t.Date()
	return t.Sub(time.Date(y, m, d, 0, 0, 0, 0, t.Location()))
}

// seriesInput is what the series are counted from: the board's own input,
// the releases each merge shipped in, the busiest workflow's name and the
// open count the In flight figure prints.
type seriesInput struct {
	in       boardInput
	shipped  map[int]github.RepoRelease // pull request number → release
	workflow string
	openNow  int
}

// flowSeries is every figure's series over the window, keyed by figure.
func flowSeries(s seriesInput) map[string][]FlowPoint {
	in := s.in
	if in.days <= 0 {
		return map[string][]FlowPoint{}
	}
	names, starts := github.WindowDays(in.now, in.days)
	nowClock := clockOf(in.now)
	day := func(t int64) int { return github.DayOf(t, in.now, in.days) }
	beforeClock := func(t int64) bool { return clockOf(time.UnixMilli(t).In(in.now.Location())) <= nowClock }

	merged := func(p github.BranchPR) bool { return p.State == "merged" && p.MergedAt > 0 }
	counts := make([]int, in.days)
	countsByNow := make([]int, in.days)
	cost := make([]float64, in.days)
	costByNow := make([]float64, in.days)
	ttm := make([][]int64, in.days)
	lag := make([][]int64, in.days)
	for _, p := range in.prs {
		if !merged(p) {
			continue
		}
		if i := day(p.MergedAt); i >= 0 {
			counts[i]++
			c := in.spend[p.URL].CostUSD
			cost[i] += c
			if beforeClock(p.MergedAt) {
				countsByNow[i]++
				costByNow[i] += c
			}
			if p.CreatedAt > 0 && p.MergedAt >= p.CreatedAt {
				ttm[i] = append(ttm[i], p.MergedAt-p.CreatedAt)
			}
		}
		// Merged → released by the day the release was published: a merge
		// not released yet is in no day, so the newest days are not skewed
		// toward the merges that happened to ship fast.
		if r, ok := s.shipped[p.Number]; ok {
			if i := day(r.PublishedAt); i >= 0 && r.PublishedAt >= p.MergedAt {
				lag[i] = append(lag[i], r.PublishedAt-p.MergedAt)
			}
		}
	}

	ci := make([][]int64, in.days)
	if s.workflow != "" {
		for _, r := range in.runs {
			if r.Name != s.workflow || r.Status != "completed" || r.Conclusion != "success" {
				continue
			}
			begin := r.StartedAt
			if begin == 0 {
				begin = r.CreatedAt
			}
			if span := r.UpdatedAt - r.StartedAt; r.StartedAt > 0 && span > 0 {
				if i := day(begin); i >= 0 {
					ci[i] = append(ci[i], span)
				}
			}
		}
	}

	// In flight at each day's end (today: now): opened by then and not yet
	// merged or closed. A closed pull request without its closing stamp
	// cannot be placed and is left out of the past days.
	flight := make([]int, in.days)
	for i := range flight {
		end := in.now.UnixMilli()
		if i+1 < in.days {
			end = starts[i+1].UnixMilli()
		}
		for _, p := range in.prs {
			if p.CreatedAt == 0 || p.CreatedAt >= end {
				continue
			}
			switch p.State {
			case "open":
			case "merged":
				if p.MergedAt > 0 && p.MergedAt < end {
					continue
				}
			default:
				if p.ClosedAt == 0 || p.ClosedAt < end {
					continue
				}
			}
			flight[i]++
		}
	}
	// Today's point is the figure itself, so the line ends where the number is.
	flight[in.days-1] = s.openNow

	out := map[string][]FlowPoint{}
	mk := func(f func(i int) FlowPoint) []FlowPoint {
		pts := make([]FlowPoint, in.days)
		for i := range pts {
			pts[i] = f(i)
			pts[i].Day = names[i]
		}
		return pts
	}
	med := func(xs [][]int64) []FlowPoint {
		return mk(func(i int) FlowPoint {
			p := FlowPoint{N: len(xs[i])}
			if v, ok := medianOf(xs[i]); ok {
				p.Value = f64(v)
			}
			return p
		})
	}
	out[SeriesFlight] = mk(func(i int) FlowPoint { return FlowPoint{Value: f64(float64(flight[i])), N: flight[i]} })
	out[SeriesThroughput] = mk(func(i int) FlowPoint {
		return FlowPoint{Value: f64(float64(counts[i])), N: counts[i], ByNow: f64(float64(countsByNow[i]))}
	})
	out[SeriesCost] = mk(func(i int) FlowPoint {
		return FlowPoint{Value: f64(cost[i]), N: counts[i], ByNow: f64(costByNow[i])}
	})
	out[SeriesTTM] = med(ttm)
	out[SeriesLag] = med(lag)
	if s.workflow != "" {
		out[SeriesCI] = med(ci)
	}
	return out
}
