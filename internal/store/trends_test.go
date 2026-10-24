package store

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
)

func toolAt(t *testing.T, s *Store, sid string, at time.Time) {
	t.Helper()
	ev := &event.Event{SessionID: sid, Source: event.SourceTranscript, Kind: event.KindToolPre, Tool: "Read", Ts: at,
		Key: fmt.Sprintf("tool-%s-%d", sid, at.UnixMilli())}
	if _, err := InsertEvent(context.Background(), s.db, ev); err != nil {
		t.Fatal(err)
	}
}

// Every day is cut at the same time of day as now, a quiet day stays in the
// series as inactive, and today's figures are today's so far.
func TestTrendsCutAtTimeOfDay(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	loc := time.FixedZone("test", 2*3600)
	now := time.Date(2026, 10, 14, 10, 30, 0, 0, loc)
	at := func(daysAgo, h, m int) time.Time {
		return time.Date(2026, 10, 14-daysAgo, h, m, 0, 0, loc)
	}
	// Yesterday: $2 before 10:30, $5 after it. Two sessions in one morning
	// bucket, a third only in the afternoon.
	spend(t, s, "y1", at(1, 9, 0).UnixMilli(), 100, 1)
	spend(t, s, "y2", at(1, 9, 4).UnixMilli(), 100, 1)
	toolAt(t, s, "y1", at(1, 9, 1))
	spend(t, s, "y3", at(1, 15, 0).UnixMilli(), 100, 5)
	// Three days ago: only an afternoon. Active, but nothing by 10:30.
	spend(t, s, "a1", at(3, 16, 0).UnixMilli(), 100, 4)
	// Today so far.
	spend(t, s, "t1", at(0, 8, 0).UnixMilli(), 100, 3)
	// Fifteen days ago: outside the window.
	spend(t, s, "old", at(15, 9, 0).UnixMilli(), 100, 100)

	tr, err := TrendsAt(ctx, s.db, now, "")
	if err != nil {
		t.Fatal(err)
	}
	if tr.Days != TrendDays || len(tr.Series) != TrendDays+1 || tr.CutMin != 10*60+30 {
		t.Fatalf("trends = %+v", tr)
	}
	last := tr.Series[TrendDays]
	if last.Day != "2026-10-14" || last.CostUSD != 3 || last.Turns != 1 || last.Sessions != 1 || !last.Active {
		t.Fatalf("today = %+v", last)
	}
	y := tr.Series[TrendDays-1]
	if y.Day != "2026-10-13" || y.CostUSD != 2 || y.Turns != 2 || y.ToolCalls != 1 || y.Sessions != 2 || !y.Active {
		t.Fatalf("yesterday cut at 10:30 = %+v, want $2, 2 turns, 1 tool call, 2 sessions", y)
	}
	a := tr.Series[TrendDays-3]
	if a.CostUSD != 0 || a.Sessions != 0 || !a.Active {
		t.Fatalf("an afternoon-only day = %+v, want active with nothing by the cut", a)
	}
	if q := tr.Series[TrendDays-2]; q.Active || q.CostUSD != 0 {
		t.Fatalf("a quiet day = %+v", q)
	}
	if tr.Series[0].Day != "2026-09-30" || tr.Series[0].CostUSD != 0 {
		t.Fatalf("first day = %+v (the 15-day-old $100 must not count)", tr.Series[0])
	}
	// Burn: the previous days' windows only, whole days. Yesterday has two
	// windows ($2 in 09:00-09:10 = $12/h, $5 at 15:00 = $30/h), three days
	// ago one ($4 = $24/h): median $24/h over 3 windows on 2 days.
	if tr.Burn == nil || tr.Burn.Windows != 3 || tr.Burn.Days != 2 || tr.Burn.MedianUSDPerHour != 24 {
		t.Fatalf("burn = %+v", tr.Burn)
	}
	if y.BurnUSDPerHour == nil || *y.BurnUSDPerHour != 21 {
		t.Fatalf("yesterday's burn = %v, want the median of 12 and 30", y.BurnUSDPerHour)
	}
	if y.HitRate == nil || *y.HitRate != 0 {
		t.Fatalf("hit rate = %v, want 0 (no cache reads)", y.HitRate)
	}
}

// The agent filter reaches every figure.
func TestTrendsAgentFilter(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 10, 14, 12, 0, 0, 0, time.UTC)
	s := filterStore(t)
	seed(t, s, "c1", "codex", "p", now.Add(-time.Hour).UnixMilli(), 1, 100)
	seed(t, s, "k1", "claude", "p", now.Add(-2*time.Hour).UnixMilli(), 2, 100)
	tr, err := TrendsAt(ctx, s.db, now, "codex")
	if err != nil {
		t.Fatal(err)
	}
	if d := tr.Series[TrendDays]; d.CostUSD != 1 || d.Sessions != 1 {
		t.Fatalf("codex today = %+v, want only its own $1", d)
	}
	tr, err = TrendsAt(ctx, s.db, now, "")
	if err != nil {
		t.Fatal(err)
	}
	if d := tr.Series[TrendDays]; d.CostUSD != 3 || d.Sessions != 2 {
		t.Fatalf("all today = %+v", d)
	}
}
