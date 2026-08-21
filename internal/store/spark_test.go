package store

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
)

// spend inserts one priced assistant turn for a session at ts.
func spend(t *testing.T, s *Store, sid string, ts int64, tokens int64, usd float64) {
	t.Helper()
	ev := &event.Event{
		SessionID: sid, Source: event.SourceTranscript, Kind: event.KindTurnAssistant,
		Model: "claude-opus-5", Ts: time.UnixMilli(ts),
		Tokens: &event.TokenDelta{In: tokens}, CostUSD: &usd,
		Key: fmt.Sprintf("%s-%d-%f", sid, ts, usd),
	}
	if _, err := InsertEvent(context.Background(), s.db, ev); err != nil {
		t.Fatal(err)
	}
}

// The bucket index is the whole sparkline: get it wrong and every column shows
// the wrong day. Boundaries are the part that actually breaks — an event at a
// bucket's first millisecond belongs to that bucket, and one at the window's
// end belongs to no bucket at all rather than being clamped into the last.
func TestSparkSpecBucketBoundaries(t *testing.T) {
	const day = int64(86_400_000)
	spec := SparkSpec{Buckets: 3, WidthMs: day, FromMs: 1_000_000}
	cases := []struct {
		name string
		ts   int64
		want int
		ok   bool
	}{
		{"first ms of bucket 0", spec.FromMs, 0, true},
		{"last ms of bucket 0", spec.FromMs + day - 1, 0, true},
		{"first ms of bucket 1", spec.FromMs + day, 1, true},
		{"last ms of the window", spec.FromMs + 3*day - 1, 2, true},
		// One millisecond past the end is out, not clamped into bucket 2: a
		// clamp would draw a spike on the final column that never happened.
		{"one ms past the window", spec.FromMs + 3*day, 0, false},
		{"long past the window", spec.FromMs + 99*day, 0, false},
		{"before the window", spec.FromMs - 1, 0, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, ok := spec.bucket(c.ts)
			if ok != c.ok || (ok && got != c.want) {
				t.Fatalf("bucket(%d) = (%d, %v), want (%d, %v)", c.ts, got, ok, c.want, c.ok)
			}
		})
	}
	// A zero spec must never claim a bucket, or the burn summary would start
	// allocating series it never asked for.
	if _, ok := (SparkSpec{}).bucket(1_000_000); ok {
		t.Fatal("zero SparkSpec claimed a bucket; it must disable the series entirely")
	}
}

// A day in the middle with no work must come back as a real zero, not as a
// missing entry — the panel draws an empty bucket as a hairline, and it can
// only do that if the zero is actually there.
func TestSummarizeSparkKeepsEmptyBuckets(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	const day = int64(86_400_000)
	from := 10 * day
	// Spend on bucket 0 and bucket 2; bucket 1 is deliberately silent.
	spend(t, s, "s1", from+1000, 10, 1.0)
	spend(t, s, "s1", from+2*day+1000, 30, 3.0)
	if err := UpsertSession(ctx, s.db, "s1", SessionPatch{Project: "alpha"}); err != nil {
		t.Fatal(err)
	}
	sum, err := SummarizeSpark(ctx, s.db, from, SparkSpec{Buckets: 3, WidthMs: day, FromMs: from})
	if err != nil {
		t.Fatal(err)
	}
	if len(sum.Projects) != 1 {
		t.Fatalf("projects = %d, want 1: %+v", len(sum.Projects), sum.Projects)
	}
	sp := sum.Projects[0].Spark
	if sp == nil {
		t.Fatal("no spark on the project row")
	}
	if len(sp.Cost) != 3 || len(sp.Tokens) != 3 {
		t.Fatalf("series lengths = %d/%d, want 3/3", len(sp.Cost), len(sp.Tokens))
	}
	if sp.Cost[0] != 1.0 || sp.Cost[2] != 3.0 {
		t.Fatalf("cost series = %v, want [1 0 3]", sp.Cost)
	}
	// The silent day is the point of this test.
	if sp.Cost[1] != 0 || sp.Tokens[1] != 0 {
		t.Fatalf("quiet bucket = (%v, %v), want zero — an absent bucket cannot be drawn as silence", sp.Cost[1], sp.Tokens[1])
	}
	if sp.Tokens[0] != 10 || sp.Tokens[2] != 30 {
		t.Fatalf("token series = %v, want [10 0 30]", sp.Tokens)
	}
	if sp.FromMs != from || sp.WidthMs != day {
		t.Fatalf("grid = (%d, %d), want (%d, %d)", sp.FromMs, sp.WidthMs, from, day)
	}
}

// The sparkline sits beside the row's own total, so the two must agree exactly.
// If a bucket were dropped or double-counted the picture would quietly disagree
// with the number (rule 6).
func TestSummarizeSparkSumsToRowTotal(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	const hour = int64(3_600_000)
	from := 100 * hour
	// The bucket grid starts one hour AFTER the range does, which is the case
	// that separates "the row total" from "the sum of the columns": the first
	// turn is inside the range and has no column to be drawn in, and its money
	// must still reach the row (rule 6 — dropping it understates the bill).
	gridFrom := from + hour
	spend(t, s, "a", from+5, 100, 2.5) // before the grid: counted, not drawn
	spend(t, s, "a", gridFrom+5, 200, 1.25)
	spend(t, s, "b", gridFrom+2*hour+9, 300, 0.75)
	spend(t, s, "b", gridFrom+4*hour+9, 400, 4.0)
	if err := UpsertSession(ctx, s.db, "a", SessionPatch{Project: "alpha"}); err != nil {
		t.Fatal(err)
	}
	if err := UpsertSession(ctx, s.db, "b", SessionPatch{Project: "alpha"}); err != nil {
		t.Fatal(err)
	}
	sum, err := SummarizeSpark(ctx, s.db, from, SparkSpec{Buckets: 5, WidthMs: hour, FromMs: gridFrom})
	if err != nil {
		t.Fatal(err)
	}
	if len(sum.Projects) != 1 {
		t.Fatalf("projects = %d, want 1", len(sum.Projects))
	}
	p := sum.Projects[0]
	if p.Spark == nil {
		t.Fatal("no spark")
	}
	// The row carries every dollar in the range, including the turn that has no
	// column.
	if math.Abs(p.CostUSD-8.5) > 1e-9 || p.Tokens != 1000 {
		t.Fatalf("row totals = (%v, %d), want (8.5, 1000) — spend before the grid still belongs to the row", p.CostUSD, p.Tokens)
	}
	var cost float64
	var tok int64
	for i := range p.Spark.Cost {
		cost += p.Spark.Cost[i]
		tok += p.Spark.Tokens[i]
	}
	// The columns carry only what the grid covers, and that is the drawable
	// part of the same money — never more than the row.
	if math.Abs(cost-6.0) > 1e-9 || tok != 900 {
		t.Fatalf("spark sums = (%v, %d), want (6, 900)", cost, tok)
	}
	if cost > p.CostUSD+1e-9 {
		t.Fatalf("spark (%v) exceeds the row total (%v) — the picture would overstate the number beside it", cost, p.CostUSD)
	}
	if p.Sessions != 2 {
		t.Fatalf("sessions = %d, want 2", p.Sessions)
	}
}

// The two-level roll-up must still add up: the parts of a repository sum to the
// repository's own total. The panel shows both at once, and stating two
// different totals for one repository is exactly what rule 6 forbids.
func TestSummarizeSparkPathsStillSumToRepo(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	const day = int64(86_400_000)
	from := 20 * day
	// filepath.Join, not string concatenation: the separator differs on the
	// Windows runner and a hardcoded "/" would make this test a red CI job.
	root := newRepo(t, filepath.Join(t.TempDir(), "mono"))
	ui := filepath.Join(root, "ui")
	cmd := filepath.Join(root, "cmd")
	for _, d := range []string{ui, cmd} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	// The breakdown is charged by what each turn TOUCHED, so each session gets
	// a turn plus a touch in the directory it is meant to represent. Driving it
	// through cwd alone would no longer produce three directory rows — which is
	// the whole point of the change this test now guards.
	spendTouching(t, s, "u", "mu", from+1000, 10, 4.0, filepath.Join(ui, "a.ts"))
	spendTouching(t, s, "c", "mc", from+day+1000, 20, 6.0, filepath.Join(cmd, "b.go"))
	spendTouching(t, s, "r", "mr", from+2*day+1000, 30, 1.0, filepath.Join(root, "c.md"))
	if err := UpsertSession(ctx, s.db, "u", SessionPatch{Cwd: ui}); err != nil {
		t.Fatal(err)
	}
	if err := UpsertSession(ctx, s.db, "c", SessionPatch{Cwd: cmd}); err != nil {
		t.Fatal(err)
	}
	if err := UpsertSession(ctx, s.db, "r", SessionPatch{Cwd: root}); err != nil {
		t.Fatal(err)
	}
	sum, err := SummarizeSpark(ctx, s.db, from, SparkSpec{Buckets: 3, WidthMs: day, FromMs: from})
	if err != nil {
		t.Fatal(err)
	}
	if len(sum.Projects) != 1 {
		t.Fatalf("projects = %d, want 1: %+v", len(sum.Projects), sum.Projects)
	}
	p := sum.Projects[0]
	if len(p.Paths) != 3 {
		t.Fatalf("paths = %d, want 3: %+v", len(p.Paths), p.Paths)
	}
	var pc float64
	var pt, ps int64
	for _, q := range p.Paths {
		pc += q.CostUSD
		pt += q.Tokens
		ps += q.Turns
	}
	if math.Abs(pc-p.CostUSD) > 1e-9 {
		t.Fatalf("paths sum to %v but the repository says %v", pc, p.CostUSD)
	}
	if pt != p.Tokens {
		t.Fatalf("path tokens sum to %d but the repository says %d", pt, p.Tokens)
	}
	// Turns, not sessions: a session can touch several directories, so it
	// cannot be counted once per row without the column exceeding the
	// repository's own session count. A turn is charged to exactly one row.
	if ps != 3 {
		t.Fatalf("path turns sum to %d but 3 turns were recorded", ps)
	}
	// And the sparkline agrees with that same total.
	var sc float64
	for _, v := range p.Spark.Cost {
		sc += v
	}
	if math.Abs(sc-p.CostUSD) > 1e-9 {
		t.Fatalf("spark sums to %v but the repository says %v", sc, p.CostUSD)
	}
}

// Summarize is the no-series path used by the 10-minute burn figure, which is
// computed on every poll. It must not build series nobody asked for.
func TestSummarizeWithoutSparkCarriesNoSeries(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	spend(t, s, "s1", 5_000_000, 10, 1.0)
	if err := UpsertSession(ctx, s.db, "s1", SessionPatch{Project: "alpha"}); err != nil {
		t.Fatal(err)
	}
	sum, err := Summarize(ctx, s.db, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(sum.Projects) != 1 {
		t.Fatalf("projects = %d, want 1", len(sum.Projects))
	}
	if sum.Projects[0].Spark != nil {
		t.Fatal("Summarize built a spark series; the burn path must pay nothing for it")
	}
	// The totals must be identical either way.
	if sum.Projects[0].CostUSD != 1.0 || sum.Projects[0].Tokens != 10 {
		t.Fatalf("totals = (%v, %d), want (1, 10)", sum.Projects[0].CostUSD, sum.Projects[0].Tokens)
	}
}

// spendTouching is spend() plus the tool call that says where the money went —
// the pair the per-directory breakdown is built from.
func spendTouching(t *testing.T, s *Store, sid, msg string, ts int64, tokens int64, usd float64, file string) {
	t.Helper()
	ev := &event.Event{
		SessionID: sid, Source: event.SourceTranscript, Kind: event.KindTurnAssistant,
		Model: "claude-opus-5", Ts: time.UnixMilli(ts),
		Tokens: &event.TokenDelta{In: tokens}, CostUSD: &usd,
		MsgID: msg, Key: "msg:" + msg,
	}
	if _, err := InsertEvent(context.Background(), s.db, ev); err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(map[string]any{
		"tool_name": "Read", "tool_input": map[string]any{"file_path": file},
		"tool_use_id": "toolu_" + msg, "message_id": msg,
	})
	if err != nil {
		t.Fatal(err)
	}
	tp := &event.Event{
		SessionID: sid, Source: event.SourceTranscript, Kind: event.KindToolPre,
		Tool: "Read", Ts: time.UnixMilli(ts), Payload: payload,
		MsgID: msg, Key: "pre:" + msg,
	}
	if _, err := InsertEvent(context.Background(), s.db, tp); err != nil {
		t.Fatal(err)
	}
}
