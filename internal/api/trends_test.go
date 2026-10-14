package api

import (
	"testing"

	"github.com/dspv/caprock/internal/store"
)

// /v1/stats/trends answers the 14 previous days and today, with today's
// figures matching the summary's, and rejects an unknown agent.
func TestTrendsEndpoint(t *testing.T) {
	e := newEnv(t)
	e.seed(t, t.TempDir())
	var tr store.Trends
	if code := e.get(t, "/v1/stats/trends", &tr); code != 200 {
		t.Fatalf("trends: %d", code)
	}
	if tr.Days != store.TrendDays || len(tr.Series) != store.TrendDays+1 {
		t.Fatalf("trends = %+v", tr)
	}
	var sum store.Summary
	e.get(t, "/v1/stats/summary", &sum)
	today := tr.Series[store.TrendDays]
	if today.Day != "2026-08-18" || today.Turns != sum.Turns || today.ToolCalls != sum.ToolCalls || today.Sessions != sum.Sessions || today.CostUSD != sum.CostUSD {
		t.Fatalf("today = %+v, summary = turns %d tools %d sessions %d $%v", today, sum.Turns, sum.ToolCalls, sum.Sessions, sum.CostUSD)
	}
	if today.Turns == 0 {
		t.Fatal("the seed has no turn; the test would prove nothing")
	}
	if code := e.get(t, "/v1/stats/trends?agent=cursor", nil); code != 400 {
		t.Fatalf("unknown agent: %d, want 400", code)
	}
	var codex store.Trends
	if code := e.get(t, "/v1/stats/trends?agent=codex", &codex); code != 200 || codex.Series[store.TrendDays].Turns != 0 {
		t.Fatalf("codex: %d %+v", code, codex.Series[store.TrendDays])
	}
}
