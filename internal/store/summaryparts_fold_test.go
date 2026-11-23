package store

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
)

// foldRanges are the ranges the fold tests keep: all time, a week by day
// and today by hour (the per-hour sparkline buckets).
func foldRanges() []struct {
	from  int64
	spark SparkSpec
} {
	day := int64(24 * time.Hour / time.Millisecond)
	midnight := time.Date(2026, 11, 20, 0, 0, 0, 0, time.UTC).UnixMilli()
	week := midnight - 6*day
	return []struct {
		from  int64
		spark SparkSpec
	}{
		{0, SparkSpec{}},
		{week, SparkSpec{Buckets: 7, WidthMs: day, FromMs: week}},
		{midnight, SparkSpec{Buckets: 24, WidthMs: 3600000, FromMs: midnight}},
	}
}

// foldCheck asks every kept range for every agent filter and compares the
// answer with the per-range queries; then holds the kept parts equal, part
// for part, to a fresh whole-range read, and the reads each range made since
// the last check to the ones wanted (sessions read whole, sessions whose new
// rows alone were read).
type foldCheck struct {
	t     *testing.T
	f     *partsFixture
	cache *PartsCache
	whole map[int64]int
	fold  map[int64]int
}

func newFoldCheck(t *testing.T) *foldCheck {
	f := newPartsFixture(t)
	f.fill()
	// A session that started before midnight and goes on after it, so the
	// day's range takes only part of it.
	f.session("cross", "claude", 0, time.Date(2026, 11, 19, 23, 40, 0, 0, time.UTC), 40)
	cache := NewPartsCache()
	cache.SetThrottle(0)
	c := &foldCheck{t: t, f: f, cache: cache, whole: map[int64]int{}, fold: map[int64]int{}}
	c.check("first read", 0, 0)
	return c
}

func (c *foldCheck) check(step string, wantWhole, wantFold int) {
	c.t.Helper()
	ctx := context.Background()
	db := c.f.s.DB()
	for _, r := range foldRanges() {
		for _, agent := range partsAgents {
			label := fmt.Sprintf("%s: from %d agent %q", step, r.from, agent)
			want, err := legacySummarizeSparkFor(ctx, db, r.from, r.spark, agent)
			if err != nil {
				c.t.Fatal(err)
			}
			got, parts, err := c.cache.Summary(ctx, db, r.from, r.spark, agent)
			if err != nil {
				c.t.Fatal(err)
			}
			sameSummary(c.t, label, want, got)
			wantParts, err := SpendPartsBetween(ctx, db, r.from, 0, agent)
			if err != nil {
				c.t.Fatal(err)
			}
			sameSummary(c.t, label+" (cost parts)", wantParts, parts)
		}
		wantTools, err := ToolDistribution(ctx, db, r.from, 100)
		if err != nil {
			c.t.Fatal(err)
		}
		tools, err := c.cache.Tools(ctx, db, r.from, 100)
		if err != nil {
			c.t.Fatal(err)
		}
		if len(tools) != len(wantTools) {
			c.t.Fatalf("%s: %d tools, want %d", step, len(tools), len(wantTools))
		}
		kp := c.cache.ranges[r.from]
		fresh, err := readParts(ctx, db, r.from, r.from, 0, partsScope{all: true}, nil)
		if err != nil {
			c.t.Fatal(err)
		}
		// The same parts, down to the order every sum was added in.
		if !reflect.DeepEqual(fresh.sids, kp.parts.sids) {
			for sid, p := range fresh.sids {
				if !reflect.DeepEqual(p, kp.parts.sids[sid]) {
					c.t.Fatalf("%s, from %d: session %d kept as\n%+v\nread afresh as\n%+v", step, r.from, sid, kp.parts.sids[sid], p)
				}
			}
			c.t.Fatalf("%s, from %d: %d sessions kept, %d read afresh", step, r.from, len(kp.parts.sids), len(fresh.sids))
		}
		if dw, df := kp.whole-c.whole[r.from], kp.folded-c.fold[r.from]; dw != wantWhole || df != wantFold {
			c.t.Fatalf("%s, from %d: %d sessions read whole and %d folded, want %d and %d", step, r.from, dw, df, wantWhole, wantFold)
		}
		c.whole[r.from], c.fold[r.from] = kp.whole, kp.folded
	}
}

func (c *foldCheck) exec(q string, args ...any) {
	c.t.Helper()
	if _, err := c.f.s.DB().ExecContext(context.Background(), q, args...); err != nil {
		c.t.Fatal(err)
	}
}

func (c *foldCheck) lastTurn(session string) (key, msg string) {
	c.t.Helper()
	if err := c.f.s.DB().QueryRowContext(context.Background(), `
		SELECT key, msg_id FROM events WHERE kind = 'turn.assistant'
		  AND sid = (SELECT sid FROM sessions WHERE session_id = ?) ORDER BY id DESC LIMIT 1`, session).Scan(&key, &msg); err != nil {
		c.t.Fatal(err)
	}
	return key, msg
}

// A session that only adds rows has just those rows read and added to the
// scan kept from its last read, and every figure stays what a fresh count
// gives: per-hour buckets, distinct sessions and models, the carry-forward
// directory, the work kinds, the tool counts. Anything else reads it whole.
func TestPartsCacheFoldsNewRows(t *testing.T) {
	c := newFoldCheck(t)
	f := c.f
	at := f.now.Add(-2 * time.Hour)
	next := func() time.Time { at = at.Add(3 * time.Minute); return at }

	f.turn("today-a", "claude", 0, next())
	c.check("first move: no scan kept yet, read whole", 1, 0)
	f.turn("today-a", "claude", 0, next())
	c.check("a new turn", 0, 1)
	for range 5 {
		f.turn("today-a", "claude", 0, next())
	}
	c.check("five new turns", 0, 1)

	// A turn in a new hour, a new model: new buckets, a new distinct model.
	at = at.Add(70 * time.Minute)
	ctx := context.Background()
	db := f.s.DB()
	f.insert(&event.Event{SessionID: "today-a", Source: event.SourceTranscript, Kind: event.KindTurnAssistant,
		Model: "claude-haiku-9", MsgID: "fresh-model", Key: "msg:fresh-model", Ts: next(), Payload: json.RawMessage(`{"text":"x"}`),
		Tokens: &event.TokenDelta{In: 5, Out: 7}})
	c.check("a new hour and a new unpriced model", 0, 1)

	// A response's later line merged into its stored turn changes a payload
	// only: the gen moves, the parts generation does not.
	key, _ := c.lastTurn("today-a")
	if changed, err := MergeAssistantText(ctx, db, "today-a", key, json.RawMessage(`{"text":"more words","tools":["Read"]}`)); err != nil || !changed {
		t.Fatalf("merge: %v %v", changed, err)
	}
	f.turn("today-a", "claude", 0, next())
	c.check("prose merged into a turn, and a new turn", 0, 1)

	c.exec(`UPDATE events SET cost_usd = cost_usd * 3 WHERE id = (SELECT MAX(id) FROM events WHERE kind = 'turn.assistant' AND cost_usd IS NOT NULL AND sid = (SELECT sid FROM sessions WHERE session_id = 'today-a'))`)
	c.check("a repriced turn", 1, 0)
	f.turn("today-a", "claude", 0, next())
	c.check("a new turn after the reprice", 0, 1)

	c.exec(`DELETE FROM events WHERE id = (SELECT MAX(id) FROM events WHERE kind = 'tool.post' AND sid = (SELECT sid FROM sessions WHERE session_id = 'today-a'))`)
	c.check("a deleted row", 1, 0)
	f.turn("today-a", "claude", 0, next())
	c.check("a new turn after the delete", 0, 1)

	// The hook stores a call first, with no message id; the transcript links
	// it moments later. The link is applied to the kept scan.
	_, msg := c.lastTurn("today-a")
	for i, tool := range []string{"Edit", "Bash"} {
		input := map[string]any{"command": "ls"}
		if tool == "Edit" {
			input = map[string]any{"file_path": f.dirs[0] + "/hooked/f.go"}
		}
		pre, _ := json.Marshal(map[string]any{"tool_name": tool, "tool_input": input})
		f.insert(&event.Event{SessionID: "today-a", Source: event.SourceHook, Kind: event.KindToolPre, Tool: tool,
			Key: fmt.Sprintf("pre:hooked%d", i), Ts: at.Add(time.Duration(10+i) * time.Second), Payload: pre})
	}
	c.check("two calls from the hook, unlinked", 0, 1)
	if linked, err := LinkToolCall(ctx, db, "today-a", "pre:hooked0", msg); err != nil || !linked {
		t.Fatalf("link: %v %v", linked, err)
	}
	c.check("one call linked to its turn", 0, 1)
	if linked, err := LinkToolCall(ctx, db, "today-a", "pre:hooked1", msg); err != nil || !linked {
		t.Fatalf("link: %v %v", linked, err)
	}
	f.turn("today-a", "claude", 0, next())
	c.check("the other linked, and a new turn", 0, 1)

	// As with hooks on: the hook's call arrives first, its turn's transcript
	// line, a few seconds older, after the call was read. Within
	// partsSettle the turn is put in order and the scan replayed from its
	// checkpoint, the session not read again; then the link.
	turnAt := next()
	hookPre, _ := json.Marshal(map[string]any{"tool_name": "Edit", "tool_input": map[string]any{"file_path": f.dirs[1] + "/late/f.go"}})
	f.insert(&event.Event{SessionID: "today-a", Source: event.SourceHook, Kind: event.KindToolPre, Tool: "Edit",
		Key: "pre:late-call", Ts: turnAt.Add(4 * time.Second), Payload: hookPre})
	c.check("a call from the hook before its turn", 0, 1)
	f.insert(&event.Event{SessionID: "today-a", Source: event.SourceTranscript, Kind: event.KindTurnAssistant, Model: "claude-opus-5",
		MsgID: "late-turn", Key: "msg:late-turn", Ts: turnAt, Payload: json.RawMessage(`{"text":"x"}`),
		CostUSD: func() *float64 { v := 0.37; return &v }(), Tokens: &event.TokenDelta{In: 3, Out: 50, CacheRead: 900}})
	c.check("its turn read a few seconds late", 0, 1)
	if linked, err := LinkToolCall(ctx, db, "today-a", "pre:late-call", "late-turn"); err != nil || !linked {
		t.Fatalf("link: %v %v", linked, err)
	}
	c.check("the call linked to the late turn", 0, 1)
	f.turn("today-a", "claude", 1, turnAt.Add(-20*time.Second))
	c.check("another turn read late, in the replay window", 0, 1)

	// A transcript line read late, older than the scan's checkpoint: the
	// carry-forward needs the session in order, so it is read whole.
	f.turn("today-a", "claude", 1, at.Add(-30*time.Minute))
	c.check("a turn read late", 1, 0)
	f.turn("today-a", "claude", 1, next())
	c.check("a new turn after the late one", 0, 1)

	// The session crossing midnight: the day's range holds only its rows
	// after midnight; a new row is added the same in every range.
	f.turn("cross", "claude", 2, f.now.Add(-time.Minute))
	c.check("crossing session, first move", 1, 0)
	f.turn("cross", "claude", 2, f.now.Add(-30*time.Second))
	c.check("crossing session, a new turn", 0, 1)

	// A new session: one more distinct session, read whole.
	f.session("brand-new", "claude", 1, f.now.Add(-10*time.Minute), 2)
	c.check("a new session", 1, 0)
	// Two sessions moving at once, one of them a Codex session.
	f.turn("brand-new", "claude", 1, f.now.Add(-time.Minute))
	f.turn("cross", "codex", 2, f.now)
	c.check("two sessions, new rows only", 0, 2)

	// A row with no new rows but a changed payload in a Cursor session:
	// its payload figures are read again, its events are not.
	c.exec(`UPDATE events SET payload = json_set(payload, '$.requests', 40) WHERE id = (SELECT MAX(id) FROM events WHERE kind = 'turn.assistant' AND sid = (SELECT sid FROM sessions WHERE session_id = 's03'))`)
	c.check("a Cursor payload changed", 0, 0)
}

// A fold reads the session's new rows alone: a seek to its end on the
// covering index, never its range.
func TestPartsCacheFoldReadsOnlyNewRows(t *testing.T) {
	c := newFoldCheck(t)
	f := c.f
	f.turn("today-a", "claude", 0, f.now.Add(-time.Hour))
	c.check("first move", 1, 0)
	f.turn("today-a", "claude", 0, f.now.Add(-50*time.Minute))
	rec := &planRecorder{Querier: f.s.DB()}
	if _, _, err := c.cache.Summary(context.Background(), rec, 0, SparkSpec{}, ""); err != nil {
		t.Fatal(err)
	}
	var folds int
	for _, r := range rec.seen {
		if !strings.Contains(r.sql, "idx_events_attr_work") {
			continue
		}
		if !strings.Contains(r.sql, "id > ?") {
			t.Fatalf("a session that only added rows was read whole: %s", r.sql)
		}
		folds++
		plan := explainPlan(t, f.s, r)
		if !strings.Contains(plan, "USING COVERING INDEX idx_events_attr_work (sid=? AND ts>?)") {
			t.Fatalf("the new rows must be a seek on the covering index: %s", plan)
		}
	}
	if folds != 1 {
		t.Fatalf("%d reads of new rows, want 1", folds)
	}
}

// The triggers behind the parts generation: a payload alone moves gen but
// not parts, a summed column moves both, a link is logged and moves only
// gen, a delete moves both.
func TestSessionPartsGeneration(t *testing.T) {
	f := newPartsFixture(t)
	f.session("g", "claude", 0, f.now.Add(-time.Hour), 3)
	ctx := context.Background()
	db := f.s.DB()
	read := func() (gen, parts, links int64) {
		t.Helper()
		if err := db.QueryRowContext(ctx, `SELECT COALESCE((SELECT gen FROM session_gen WHERE session_id = 'g'), 0),
			COALESCE((SELECT parts FROM session_gen WHERE session_id = 'g'), 0), (SELECT COUNT(*) FROM parts_links)`).Scan(&gen, &parts, &links); err != nil {
			t.Fatal(err)
		}
		return
	}
	step := func(label, q string, dGen, dParts, dLinks int64) {
		t.Helper()
		g0, p0, l0 := read()
		if _, err := db.ExecContext(ctx, q); err != nil {
			t.Fatal(err)
		}
		g1, p1, l1 := read()
		if g1-g0 != dGen || p1-p0 != dParts || l1-l0 != dLinks {
			t.Fatalf("%s: gen +%d parts +%d links +%d, want +%d +%d +%d", label, g1-g0, p1-p0, l1-l0, dGen, dParts, dLinks)
		}
	}
	last := `(SELECT MAX(id) FROM events WHERE kind = 'turn.assistant')`
	step("a payload", `UPDATE events SET payload = '{"text":"other"}' WHERE id = `+last, 1, 0, 0)
	step("a cost", `UPDATE events SET cost_usd = 9 WHERE id = `+last, 1, 1, 0)
	step("the same cost again", `UPDATE events SET cost_usd = 9 WHERE id = `+last, 1, 0, 0)
	step("a turn's message id", `UPDATE events SET msg_id = 'other' WHERE id = `+last, 1, 1, 0)
	f.insert(&event.Event{SessionID: "g", Source: event.SourceHook, Kind: event.KindToolPre, Tool: "Bash",
		Key: "pre:h", Ts: f.now, Payload: json.RawMessage(`{}`)})
	step("a call linked", `UPDATE events SET msg_id = 'm' WHERE key = 'pre:h'`, 1, 0, 1)
	step("a call unlinked", `UPDATE events SET msg_id = NULL WHERE key = 'pre:h'`, 1, 1, 0)
	step("a delete", `DELETE FROM events WHERE key = 'pre:h'`, 1, 1, 0)
}

// Links dropped from parts_links before a kept mark read them leave the
// mark unable to say what moved, so the whole range is read.
func TestPartsMovedSinceLinksDropped(t *testing.T) {
	f := newPartsFixture(t)
	ctx := context.Background()
	old := EventsMark{gens: map[string]int64{}, parts: map[string]int64{}, links: 3, linksFrom: 1}
	m := EventsMark{gens: map[string]int64{}, parts: map[string]int64{}, links: 9000, linksFrom: 4905}
	if _, all, err := m.partsMovedSince(ctx, f.s.DB(), old); err != nil || !all {
		t.Fatalf("links dropped unread: all %v err %v", all, err)
	}
	m.linksFrom = 4
	if _, all, err := m.partsMovedSince(ctx, f.s.DB(), old); err != nil || all {
		t.Fatalf("every link since kept: all %v err %v", all, err)
	}
}
