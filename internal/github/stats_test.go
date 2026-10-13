package github

import (
	"testing"
	"time"
)

// The PRs & CI tab's figures are counted on the daemon's local calendar:
// a merge late at night belongs to that day, not to the UTC one.
func TestMergesPerDayAndTimeToMerge(t *testing.T) {
	zone := time.FixedZone("UTC+3", 3*3600)
	now := time.Date(2026, 10, 13, 15, 0, 0, 0, zone)
	at := func(day, hour, minute int) int64 {
		return time.Date(2026, 10, day, hour, minute, 0, 0, zone).UnixMilli()
	}
	prs := []BranchPR{
		{Number: 1, State: "merged", CreatedAt: at(13, 10, 0), MergedAt: at(13, 10, 8)},  // today, 8 min
		{Number: 2, State: "merged", CreatedAt: at(12, 23, 0), MergedAt: at(12, 23, 50)}, // yesterday late, 50 min
		{Number: 3, State: "merged", CreatedAt: at(12, 1, 0), MergedAt: at(12, 1, 2)},    // yesterday, 2 min
		{Number: 4, State: "open", CreatedAt: at(13, 9, 0)},                              // not merged
		{Number: 5, State: "closed", CreatedAt: at(11, 9, 0), MergedAt: 0},               // closed unmerged
		{Number: 6, State: "merged", CreatedAt: at(1, 9, 0), MergedAt: at(1, 9, 30)},     // before the window
		{Number: 7, State: "merged", CreatedAt: 0, MergedAt: at(13, 11, 0)},              // no opening stamp
	}
	got := MergesPerDay(prs, now, 7)
	want := []int{0, 0, 0, 0, 0, 2, 2}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("merges = %v, want %v", got, want)
		}
	}
	// 2, 8 and 50 minutes: the median is 8; the one without an opening stamp is not counted.
	med, n := TimeToMerge(prs, now, 7)
	if n != 3 || med != 8*60_000 {
		t.Fatalf("time to merge = %d over %d", med, n)
	}
	// One merge is no median (rule 6).
	if med, n := TimeToMerge(prs[:1], now, 7); med != 0 || n != 1 {
		t.Fatalf("one merge: %d over %d", med, n)
	}
	st := Stats(prs, nil, now, 3)
	if len(st.Days) != 3 || st.Days[0] != "2026-10-11" || st.Days[2] != "2026-10-13" || st.PRsListed != len(prs) {
		t.Fatalf("stats days = %+v", st)
	}
}

// Red is a finished run that failed; a cancelled or skipped one is neither
// red nor green, a re-run is counted, and each workflow gets the median of
// its successful runs, the one taking the most time first.
func TestRunStats(t *testing.T) {
	now := time.Date(2026, 10, 13, 15, 0, 0, 0, time.UTC)
	run := func(name string, day, attempt int, concl string, minutes int) CIRun {
		start := time.Date(2026, 10, day, 10, 0, 0, 0, time.UTC).UnixMilli()
		return CIRun{Name: name, Status: "completed", Conclusion: concl, Attempt: attempt, StartedAt: start, CreatedAt: start, UpdatedAt: start + int64(minutes)*60_000}
	}
	runs := []CIRun{
		run("ci", 13, 1, "success", 6),
		run("ci", 13, 2, "success", 8),
		run("ci", 13, 1, "failure", 3),
		run("ci", 12, 1, "success", 7),
		run("ci", 12, 1, "cancelled", 1),
		run("docs", 13, 1, "success", 1),
		run("docs", 12, 1, "success", 1),
		run("docs", 12, 1, "timed_out", 1),
		{Name: "ci", Status: "in_progress", StartedAt: now.UnixMilli()},
		run("ci", 1, 1, "failure", 5), // before the window
	}
	st := RunStats(runs, now, 2)
	if st.Runs != 7 || st.Red != 2 || st.Reruns != 1 || st.Listed != len(runs) {
		t.Fatalf("counts = %+v", st)
	}
	if st.PerDay[0] != (CIDay{Runs: 3, Red: 1}) || st.PerDay[1] != (CIDay{Runs: 4, Red: 1}) {
		t.Fatalf("per day = %+v", st.PerDay)
	}
	if st.Oldest != time.Date(2026, 10, 1, 10, 0, 0, 0, time.UTC).UnixMilli() {
		t.Fatalf("oldest = %d", st.Oldest)
	}
	if len(st.Workflows) != 2 || st.Workflows[0].Name != "ci" {
		t.Fatalf("workflows = %+v", st.Workflows)
	}
	ci := st.Workflows[0]
	// 6, 7, 8 minutes: the median is 7; today has two (6, 8 → 7), yesterday one (none).
	if ci.Runs != 4 || ci.Red != 1 || ci.MedianMS != 7*60_000 || ci.MedianRuns != 3 || ci.DailyMedianMS[1] != 7*60_000 || ci.DailyMedianMS[0] != 0 {
		t.Fatalf("ci = %+v", ci)
	}
	if docs := st.Workflows[1]; docs.Runs != 3 || docs.Red != 1 || docs.MedianMS != 60_000 {
		t.Fatalf("docs = %+v", docs)
	}
}

func TestMedian(t *testing.T) {
	for _, c := range []struct {
		in   []int64
		want int64
	}{{nil, 0}, {[]int64{5}, 0}, {[]int64{4, 2}, 3}, {[]int64{9, 1, 5}, 5}} {
		if got := median(c.in); got != c.want {
			t.Fatalf("median(%v) = %d, want %d", c.in, got, c.want)
		}
	}
}
