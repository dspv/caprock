package rollup

import (
	"context"
	"encoding/json"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/cost"
	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/store"
)

// A small table so every figure below is arithmetic: input $2, cache read
// $0.20, output $10 per million tokens.
const compactTable = `{"version":"ct1","models":[{"id":"m","input":2,"cache_write_5m":2.5,"cache_write_1h":4,"cache_read":0.2,"output":10,"context_window":1000000}]}`

func compactRecorder(t *testing.T) *Recorder {
	t.Helper()
	r, _ := newRecorder(t)
	tb, err := cost.Parse([]byte(compactTable))
	if err != nil {
		t.Fatal(err)
	}
	r.Table = tb
	return r
}

func storeEv(t *testing.T, r *Recorder, ev event.Event) {
	t.Helper()
	if ev.SessionID == "" {
		ev.SessionID = "s"
	}
	ev.Source = event.SourceTranscript
	if _, err := store.InsertEvent(context.Background(), r.Store.DB(), &ev); err != nil {
		t.Fatal(err)
	}
}

func boundary(t *testing.T, r *Recorder, key string, at time.Time, pre, post, durMs int64, extra map[string]any) {
	t.Helper()
	p := map[string]any{"trigger": "auto", "pre_tokens": pre, "duration_ms": durMs, "session_id": "s"}
	if post > 0 {
		p["post_tokens"] = post
	}
	for k, v := range extra {
		p[k] = v
	}
	raw, _ := json.Marshal(p)
	storeEv(t, r, event.Event{Kind: event.KindContextCompacted, Ts: at, Key: key, Payload: raw})
}

func call(t *testing.T, r *Recorder, key string, at time.Time, read, write, write1h int64) {
	t.Helper()
	storeEv(t, r, event.Event{Kind: event.KindTurnAssistant, Ts: at, Key: key, Model: "m",
		Tokens: &event.TokenDelta{In: 10, CacheRead: read, CacheWrite: write, CacheWrite1h: write1h}})
}

func statRows(t *testing.T, r *Recorder) []store.CompactionStat {
	t.Helper()
	var out []store.CompactionStat
	all, err := r.Store.DB().Query(`SELECT event_id, at, model, pre_tokens, post_tokens, warm, est_cost_usd, turns_after, est_saved_usd, cost_stale FROM compaction_stats ORDER BY at`)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = all.Close() }()
	for all.Next() {
		var c store.CompactionStat
		if err := all.Scan(&c.EventID, &c.At, &c.Model, &c.PreTokens, &c.PostTokens, &c.Warm, &c.EstCostUSD, &c.TurnsAfter, &c.EstSavedUSD, &c.CostStale); err != nil {
			t.Fatal(err)
		}
		out = append(out, c)
	}
	if err := all.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

func near(a, b float64) bool { return math.Abs(a-b) < 1e-9 }

// The cost is the context read from the cache when the previous call was
// within the 5-minute TTL, plus the summary as output; the saving is the
// dropped tokens priced as a cache read for every main-thread call after the
// boundary and before the next one — a subagent's call and one after the
// next boundary are not counted.
func TestCompactionStatsFormulaAndCutoff(t *testing.T) {
	r := compactRecorder(t)
	ctx := context.Background()
	t0 := time.Date(2026, 10, 20, 10, 0, 0, 0, time.UTC)
	call(t, r, "msg:a", t0, 400_000, 1_000, 0)
	// Compaction starts 3 minutes after the call (ends 4 minutes after, 60 s run).
	boundary(t, r, "compact:1", t0.Add(4*time.Minute), 500_000, 0, 60_000, nil)
	if err := store.SetCompactionSummary(ctx, r.Store.DB(), "s", "1", strings.Repeat("x", 40_000)); err != nil {
		t.Fatal(err)
	}
	call(t, r, "msg:b", t0.Add(5*time.Minute), 90_000, 10_000-10, 0) // prompt 100,000: the context after
	storeEv(t, r, event.Event{Kind: event.KindTurnAssistant, Ts: t0.Add(6 * time.Minute), Key: "msg:sub", Model: "m", AgentID: "a1",
		Tokens: &event.TokenDelta{In: 10, CacheRead: 9_000}})
	call(t, r, "msg:c", t0.Add(7*time.Minute), 100_000, 0, 0)
	if _, err := r.RefreshCompactionStats(ctx); err != nil {
		t.Fatal(err)
	}
	rows := statRows(t, r)
	if len(rows) != 1 {
		t.Fatalf("rows %d", len(rows))
	}
	c := rows[0]
	// 500,000 × $0.20 + 10,000 × $10, per million.
	if !c.Warm || !c.EstCostUSD.Valid || !near(c.EstCostUSD.Float64, 0.1+0.1) || c.Model != "m" || c.CostStale {
		t.Fatalf("cost row %+v", c)
	}
	// Two main calls × 400,000 dropped × $0.20 / M.
	if c.PostTokens != 100_000 || c.TurnsAfter != 2 || !near(c.EstSavedUSD, 2*0.08) {
		t.Fatalf("saving row %+v", c)
	}

	// The next boundary closes the first: a call after it counts for the
	// second only, and the first's count is started over to stop there.
	boundary(t, r, "compact:2", t0.Add(30*time.Minute), 300_000, 50_000, 1000, nil)
	call(t, r, "msg:d", t0.Add(31*time.Minute), 50_000, 0, 0)
	if _, err := r.RefreshCompactionStats(ctx); err != nil {
		t.Fatal(err)
	}
	rows = statRows(t, r)
	if len(rows) != 2 || rows[0].TurnsAfter != 2 || !near(rows[0].EstSavedUSD, 0.16) {
		t.Fatalf("first after the second boundary: %+v", rows)
	}
	// The second: the previous call was 23 minutes before, past the 5-minute
	// TTL, so the context is uncached input; no summary read, no output.
	if rows[1].Warm || !near(rows[1].EstCostUSD.Float64, 300_000*2/1e6) {
		t.Fatalf("cold second: %+v", rows[1])
	}
	if rows[1].TurnsAfter != 1 || !near(rows[1].EstSavedUSD, 250_000*0.2/1e6) {
		t.Fatalf("second saving: %+v", rows[1])
	}

	// A further pass with no new call writes nothing.
	if n, err := r.RefreshCompactionStats(ctx); err != nil || n != 0 {
		t.Fatalf("idle pass wrote %d, %v", n, err)
	}

	tot, err := store.CompactionTotalsBetween(ctx, r.Store.DB(), 0, math.MaxInt64)
	if err != nil || tot.Count != 2 || tot.Priced != 2 || !near(tot.EstCostUSD, 0.2+0.6) || !near(tot.EstSavedUSD, 0.16+0.05) || !near(tot.NetUSD, 0.21-0.8) {
		t.Fatalf("totals %+v %v", tot, err)
	}
}

// A session that writes the 1-hour cache keeps the prefix warm for an hour.
func TestCompactionStatsOneHourTTL(t *testing.T) {
	r := compactRecorder(t)
	ctx := context.Background()
	t0 := time.Date(2026, 10, 20, 10, 0, 0, 0, time.UTC)
	call(t, r, "msg:a", t0, 400_000, 2_000, 2_000)
	boundary(t, r, "compact:1", t0.Add(40*time.Minute), 500_000, 20_000, 0, nil)
	if _, err := r.RefreshCompactionStats(ctx); err != nil {
		t.Fatal(err)
	}
	if c := statRows(t, r)[0]; !c.Warm || !near(c.EstCostUSD.Float64, 0.1) {
		t.Fatalf("1h warm: %+v", c)
	}
}

// The one-time fill is idempotent, a sidechain or forked copy of a boundary
// gets no row, a summary read later makes the cost again, and a new
// pricing version makes every figure again.
func TestCompactionStatsBackfillIdempotent(t *testing.T) {
	r := compactRecorder(t)
	ctx := context.Background()
	t0 := time.Date(2026, 10, 20, 10, 0, 0, 0, time.UTC)
	call(t, r, "msg:a", t0, 400_000, 0, 0)
	boundary(t, r, "compact:1", t0.Add(time.Minute), 500_000, 100_000, 0, nil)
	boundary(t, r, "compact:side", t0.Add(2*time.Minute), 9, 0, 0, map[string]any{"sidechain": true})
	call(t, r, "msg:b", t0.Add(3*time.Minute), 100_000, 0, 0)
	// A fork copies the parent's lines: the same boundary key in another session.
	raw, _ := json.Marshal(map[string]any{"trigger": "auto", "pre_tokens": 500_000})
	storeEv(t, r, event.Event{SessionID: "fork", Kind: event.KindContextCompacted, Ts: t0.Add(time.Minute), Key: "compact:1", Payload: raw})

	for i := 0; i < 2; i++ {
		if _, err := r.RefreshCompactionStats(ctx); err != nil {
			t.Fatal(err)
		}
	}
	rows := statRows(t, r)
	if len(rows) != 1 || rows[0].TurnsAfter != 1 || !near(rows[0].EstSavedUSD, 0.08) || !near(rows[0].EstCostUSD.Float64, 0.1) {
		t.Fatalf("after two passes: %+v", rows)
	}
	// The summary arrives: the cost is made again with the output, the
	// saving stays.
	if err := store.SetCompactionSummary(ctx, r.Store.DB(), "s", "1", strings.Repeat("y", 4_000)); err != nil {
		t.Fatal(err)
	}
	if _, err := r.RefreshCompactionStats(ctx); err != nil {
		t.Fatal(err)
	}
	if c := statRows(t, r)[0]; !near(c.EstCostUSD.Float64, 0.1+0.01) || c.TurnsAfter != 1 || !near(c.EstSavedUSD, 0.08) {
		t.Fatalf("after the summary: %+v", c)
	}
	// The same summary again changes nothing.
	_ = store.SetCompactionSummary(ctx, r.Store.DB(), "s", "1", strings.Repeat("y", 4_000))
	if n, _ := r.RefreshCompactionStats(ctx); n != 0 {
		t.Fatalf("same summary rewrote %d", n)
	}
	// A new table version: made again, same figures from the same events.
	tb, _ := cost.Parse([]byte(strings.Replace(compactTable, `"ct1"`, `"ct2"`, 1)))
	r.Table = tb
	if n, err := r.RefreshCompactionStats(ctx); err != nil || n != 1 {
		t.Fatalf("new version wrote %d, %v", n, err)
	}
	if c := statRows(t, r)[0]; !near(c.EstCostUSD.Float64, 0.11) || c.TurnsAfter != 1 || !near(c.EstSavedUSD, 0.08) {
		t.Fatalf("after a new version: %+v", c)
	}
}

// A summary whose parentUuid is not the boundary's (older Claude Code)
// belongs to the session's newest boundary.
func TestCompactionSummaryFallsBackToTheNewestBoundary(t *testing.T) {
	r := compactRecorder(t)
	ctx := context.Background()
	t0 := time.Date(2026, 10, 20, 10, 0, 0, 0, time.UTC)
	boundary(t, r, "compact:1", t0, 100_000, 0, 0, nil)
	boundary(t, r, "compact:2", t0.Add(time.Hour), 200_000, 0, 0, nil)
	if err := store.SetCompactionSummary(ctx, r.Store.DB(), "s", "not-a-boundary", "abcdefgh"); err != nil {
		t.Fatal(err)
	}
	var at, chars, toks int64
	if err := r.Store.DB().QueryRow(`SELECT at, summary_chars, summary_tokens_est FROM compaction_stats`).Scan(&at, &chars, &toks); err != nil {
		t.Fatal(err)
	}
	if at != t0.Add(time.Hour).UnixMilli() || chars != 8 || toks != 2 {
		t.Fatalf("summary on %d: %d chars, %d tokens", at, chars, toks)
	}
}
