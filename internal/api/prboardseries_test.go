package api

import (
	"testing"
	"time"

	"github.com/dspv/caprock/internal/github"
	"github.com/dspv/caprock/internal/store"
)

// The figures' series: one point per local day, today last; a median's day
// without a sample is a gap, a count's is a zero; days are cut at local
// midnight, not UTC's; the window's first midnight is in and a millisecond
// before it is out.
func TestFlowSeries(t *testing.T) {
	loc := time.FixedZone("UTC-7", -7*3600)
	now := time.Date(2026, 10, 14, 10, 0, 0, 0, loc)
	day := func(d, h, m int) int64 { return time.Date(2026, 10, d, h, m, 0, 0, loc).UnixMilli() }
	hour := int64(time.Hour / time.Millisecond)
	prs := []github.BranchPR{
		// 23:30 local on the 13th is the 14th in UTC: it is the 13th's.
		{Number: 1, URL: "u1", State: "merged", Base: "main", CreatedAt: day(13, 21, 30), MergedAt: day(13, 23, 30)},
		// Two on the 12th: one before 10:00, one after; median of 1h and 3h.
		{Number: 2, URL: "u2", State: "merged", Base: "main", CreatedAt: day(12, 8, 0), MergedAt: day(12, 9, 0)},
		{Number: 3, URL: "u3", State: "merged", Base: "main", CreatedAt: day(12, 9, 0), MergedAt: day(12, 12, 0)},
		// The window's first midnight (1 Oct) is in; a millisecond before is out.
		{Number: 4, URL: "u4", State: "merged", Base: "release/1", CreatedAt: day(30, 0, 0) - 30*24*hour, MergedAt: day(1, 0, 0)},
		{Number: 5, URL: "u5", State: "merged", Base: "release/1", CreatedAt: day(30, 0, 0) - 30*24*hour, MergedAt: day(1, 0, 0) - 1},
		// Open since the 10th; closed unmerged on the 11th at noon; closed
		// without a stamp (cannot be placed).
		{Number: 6, URL: "u6", State: "open", CreatedAt: day(10, 9, 0)},
		{Number: 7, URL: "u7", State: "closed", CreatedAt: day(10, 9, 0), ClosedAt: day(11, 12, 0)},
		{Number: 8, URL: "u8", State: "closed", CreatedAt: day(10, 9, 0)},
	}
	rels := []github.RepoRelease{{Tag: "v1", PublishedAt: day(12, 14, 0)}, {Tag: "v2", PublishedAt: day(14, 1, 30)}}
	runs := []github.CIRun{
		{Name: "CI", Status: "completed", Conclusion: "success", StartedAt: day(13, 9, 0), UpdatedAt: day(13, 9, 6)},
		{Name: "CI", Status: "completed", Conclusion: "success", StartedAt: day(13, 11, 0), UpdatedAt: day(13, 11, 8)},
		{Name: "CI", Status: "completed", Conclusion: "failure", StartedAt: day(12, 11, 0), UpdatedAt: day(12, 11, 1)},
		{Name: "Docs", Status: "completed", Conclusion: "success", StartedAt: day(12, 11, 0), UpdatedAt: day(12, 11, 1)},
	}
	spend := map[string]store.PRSpend{"u2": {CostUSD: 2}, "u3": {CostUSD: 3}}
	b := buildBoard(boardInput{prs: prs, runs: runs, releases: rels, defaultBranch: "main", spend: spend, now: now, days: 14})
	s := b.Flow.Series

	for _, k := range []string{SeriesFlight, SeriesThroughput, SeriesCI, SeriesTTM, SeriesLag, SeriesCost} {
		if len(s[k]) != 14 {
			t.Fatalf("%s: %d points, want 14", k, len(s[k]))
		}
		if s[k][0].Day != "2026-10-01" || s[k][13].Day != "2026-10-14" {
			t.Fatalf("%s: days %s…%s", k, s[k][0].Day, s[k][13].Day)
		}
	}
	if _, ok := s["fix"]; ok {
		t.Error("needs a fix has a series: a past day's checks are not read")
	}
	val := func(p FlowPoint) float64 {
		if p.Value == nil {
			return -1
		}
		return *p.Value
	}
	th := s[SeriesThroughput]
	if val(th[12]) != 1 || val(th[11]) != 2 || val(th[0]) != 1 || val(th[13]) != 0 {
		t.Errorf("throughput = %v %v %v %v", val(th[0]), val(th[11]), val(th[12]), val(th[13]))
	}
	// By now (10:00): the 12th's 09:00 merge, not its 12:00; the 13th's 23:30 not.
	if *th[11].ByNow != 1 || *th[12].ByNow != 0 {
		t.Errorf("by now: 12th %v, 13th %v", *th[11].ByNow, *th[12].ByNow)
	}
	ttm := s[SeriesTTM]
	if val(ttm[11]) != float64(2*hour) || ttm[11].N != 2 {
		t.Errorf("ttm 12th = %v n %d, want the median of 1h and 3h", val(ttm[11]), ttm[11].N)
	}
	if val(ttm[12]) != float64(2*hour) || ttm[12].N != 1 {
		t.Errorf("ttm 13th = %v n %d, want its one merge's 2h", val(ttm[12]), ttm[12].N)
	}
	if ttm[5].Value != nil || ttm[5].N != 0 {
		t.Errorf("a day without a merge is a gap, got %v", val(ttm[5]))
	}
	// Merged → released by the release's day: v1 (12th 14:00) shipped #2
	// and #3 (5h, 2h), v2 (14th 01:30) shipped #1 (2h).
	lag := s[SeriesLag]
	if val(lag[11]) != float64(7*hour)/2 || lag[11].N != 2 {
		t.Errorf("lag 12th = %v n %d", val(lag[11]), lag[11].N)
	}
	if val(lag[13]) != float64(2*hour) || lag[12].Value != nil {
		t.Errorf("lag 14th = %v, 13th = %v", val(lag[13]), val(lag[12]))
	}
	ci := s[SeriesCI]
	if val(ci[12]) != float64(7*time.Minute/time.Millisecond) || ci[12].N != 2 || ci[11].Value != nil {
		t.Errorf("ci 13th = %v n %d, 12th %v (a red run and another workflow are not samples)", val(ci[12]), ci[12].N, val(ci[11]))
	}
	if c := s[SeriesCost]; val(c[11]) != 5 || *c[11].ByNow != 2 {
		t.Errorf("cost 12th = %v by now %v", val(c[11]), *c[11].ByNow)
	}
	// In flight at each day's end: #6 from the 10th on, #7 the 10th only
	// (closed at noon on the 11th), #8 never (no closing stamp); #4 was
	// open until the 1st's midnight, so not at its end. Today is the
	// figure: the board's one open card.
	fl := s[SeriesFlight]
	if val(fl[9]) != 2 || val(fl[10]) != 1 || val(fl[12]) != 1 || val(fl[0]) != 0 || val(fl[13]) != 1 {
		t.Errorf("in flight = %v", []float64{val(fl[0]), val(fl[9]), val(fl[10]), val(fl[12]), val(fl[13])})
	}
	// #5 opened before the window and merged a millisecond before it: open
	// on no day of it.
	if val(fl[0]) != 0 {
		t.Error("#5 counted in flight")
	}
}

// One sample is its own median for a day; none is no value.
func TestMedianOf(t *testing.T) {
	if _, ok := medianOf(nil); ok {
		t.Error("median of nothing")
	}
	if v, _ := medianOf([]int64{5}); v != 5 {
		t.Errorf("median of one = %v", v)
	}
	if v, _ := medianOf([]int64{9, 1, 4}); v != 4 {
		t.Errorf("median of three = %v", v)
	}
}
