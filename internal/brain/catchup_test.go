package brain

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/store"
)

// oldRun records a read as the code before 2026-10-22 made it — ok, from
// `from` through the session's newest event — and lists it as a possible
// gap with migration 0068's own statement, as an upgrade does.
func (e *env) oldRun(t *testing.T, session string, from, through int64) {
	t.Helper()
	ctx := context.Background()
	at := e.now.Add(-30 * 24 * time.Hour).UnixMilli()
	if _, err := store.InsertBrainRun(ctx, e.st.DB(), store.BrainRun{SessionID: session, FromEventID: from, ThroughEventID: through,
		Status: store.BrainRunOK, StartedAt: at, FinishedAt: at, TokensIn: 4000}); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile("../store/migrations/0068_brain_gaps.sql")
	if err != nil {
		t.Fatal(err)
	}
	src := string(b)
	i := strings.Index(src, "INSERT OR IGNORE INTO brain_gaps")
	if i < 0 {
		t.Fatal("the listing is not in the migration")
	}
	if _, err := e.st.DB().ExecContext(ctx, src[i:]); err != nil {
		t.Fatal(err)
	}
}

// gaps is every row of brain_gaps, oldest first.
func gaps(t *testing.T, e *env) []store.BrainGap {
	t.Helper()
	rows, err := e.st.DB().Query(`SELECT id, run_id, session_id, from_event_id, COALESCE(to_event_id, 0), cursor, status, reads_total, reads_done, attempts FROM brain_gaps ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []store.BrainGap
	for rows.Next() {
		var g store.BrainGap
		if err := rows.Scan(&g.ID, &g.RunID, &g.SessionID, &g.FromEventID, &g.ToEventID, &g.Cursor, &g.Status, &g.ReadsTotal, &g.ReadsDone, &g.Attempts); err != nil {
			t.Fatal(err)
		}
		out = append(out, g)
	}
	return out
}

// skippedLong is a long session read the old way: 60 turns, one read that
// kept the newest 24,000 characters. It returns the answers' event ids.
func (e *env) skippedLong(t *testing.T) []int64 {
	t.Helper()
	ids := e.longSession(t, 60)
	e.oldRun(t, "long", 0, ids[59])
	return ids
}

func isCatchUp(r Request) bool { return strings.HasPrefix(r.Prompt, earlierPart) }

func TestGapsAreFoundByTheOldCutOnceAndAgain(t *testing.T) {
	e := newEnv(t, twoMemories)
	ctx := context.Background()
	ids := e.skippedLong(t)
	// A short session read whole by the old code: nothing was skipped.
	short := e.session(t, "short", "acme-api", time.Hour, [2]string{"Why?", long})
	e.oldRun(t, "short", 0, short)

	if err := e.eng.FindGaps(ctx); err != nil {
		t.Fatal(err)
	}
	g := gaps(t, e)
	if len(g) != 1 || g[0].SessionID != "long" || g[0].Status != store.BrainGapPending || g[0].FromEventID != 0 || g[0].Cursor != 0 {
		t.Fatalf("gaps: %+v", g)
	}
	// What the old read sent is what follows the gap: it fits in the old
	// budget, and one passage more would not have.
	passages, _ := store.BrainOldWindow(ctx, e.st.DB(), "long", 0, ids[59], oldPassages)
	size := func(p store.BrainPassage) int {
		t := strings.Join(strings.Fields(p.Text), " ")
		if p.User {
			return len(clip(t, oldPromptChars)) + 16
		}
		return len(clip(t, answerChars)) + 16
	}
	sentChars, prev := 0, 0
	for _, p := range passages {
		if p.EventID > g[0].ToEventID {
			sentChars += size(p)
		} else {
			prev = size(p)
		}
	}
	if sentChars > MaxInputChars || sentChars+prev <= MaxInputChars || g[0].ToEventID <= ids[30] {
		t.Fatalf("gap through %d: the old read sent %d chars, one more passage %d", g[0].ToEventID, sentChars, prev)
	}
	if g[0].ReadsTotal < 5 || g[0].ReadsTotal > 8 {
		t.Errorf("reads to catch up: %d", g[0].ReadsTotal)
	}

	// Again, and with the listing re-run: nothing changes.
	e.oldRun(t, "short", short, short)
	_, _ = e.st.DB().Exec(`DELETE FROM brain_gaps WHERE run_id = (SELECT MAX(id) FROM brain_runs)`)
	e.oldRun(t, "short", short, short)
	if err := e.eng.FindGaps(ctx); err != nil {
		t.Fatal(err)
	}
	if again := gaps(t, e); len(again) != 1 || again[0] != g[0] {
		t.Errorf("a second pass changed the gaps: %+v, was %+v", again, g)
	}
}

func TestTheCatchUpReadsTheGapOldestFirstAndResumesAfterARestart(t *testing.T) {
	e := newEnv(t, twoMemories)
	ctx := context.Background()
	ids := e.skippedLong(t)
	if n, err := e.eng.Wake(ctx); n != Batch || err != nil {
		t.Fatalf("first wake read %d: %v", n, err)
	}
	// A restart: a new engine on the same database.
	old := e.eng
	e.eng = &Engine{Store: e.st, Now: old.Now, Config: old.Config, Runner: old.Runner}
	for i := 0; i < 5; i++ {
		if n, _ := e.eng.Wake(ctx); n == 0 {
			break
		}
	}
	g := gaps(t, e)
	if g[0].Status != store.BrainGapDone || g[0].Cursor != g[0].ToEventID || g[0].ReadsDone != g[0].ReadsTotal || g[0].ReadsDone != len(e.reqs) {
		t.Fatalf("gap after the catch-up: %+v, %d reads", g[0], len(e.reqs))
	}
	// Every skipped turn sent once, in order, and none the old read sent.
	var all []int
	for i, r := range e.reqs {
		if !isCatchUp(r) {
			t.Errorf("read %d is not marked as an earlier part", i+1)
		}
		all = append(all, sent(r)...)
	}
	for i, n := range all {
		if n != i {
			t.Fatalf("answer %d sent at position %d: %v", n, i, all)
		}
	}
	if len(all) == 0 || ids[len(all)-1] > g[0].ToEventID || (len(all) < 60 && ids[len(all)] <= g[0].ToEventID) {
		t.Errorf("sent %d answers for a gap through %d", len(all), g[0].ToEventID)
	}
	// The memories carry the session's project, as a regular read's do.
	var n int
	_ = e.st.DB().QueryRow(`SELECT COUNT(*) FROM brain_nodes WHERE project = 'acme-api' AND session_id = 'long' AND kind = 'decision'`).Scan(&n)
	if n != len(e.reqs) {
		t.Errorf("%d decisions with the project, want %d", n, len(e.reqs))
	}
	// The regular cursor did not move back: the session is not waiting.
	if c, _ := store.BrainCandidates(ctx, e.st.DB(), 0, e.now.UnixMilli(), 10); len(c) != 0 {
		t.Errorf("candidates after the catch-up: %+v", c)
	}
	if st := e.eng.Status(ctx); st.CatchUp != nil {
		t.Errorf("catch-up in the status after it finished: %+v", st.CatchUp)
	}
}

func TestRegularReadsComeBeforeTheCatchUp(t *testing.T) {
	e := newEnv(t, twoMemories)
	ctx := context.Background()
	e.skippedLong(t)
	for i := 0; i < Batch; i++ {
		e.session(t, fmt.Sprintf("new%d", i), "p", time.Duration(i+1)*time.Hour, [2]string{"Why?", long})
	}
	e.session(t, "one-more", "p", 9*time.Hour, [2]string{"Why?", long})
	if n, _ := e.eng.Wake(ctx); n != Batch {
		t.Fatalf("read %d", n)
	}
	for i, r := range e.reqs {
		if isCatchUp(r) {
			t.Fatalf("read %d was the catch-up while sessions waited", i+1)
		}
	}
	// One session left: it goes first, the catch-up takes the rest.
	if n, _ := e.eng.Wake(ctx); n != Batch {
		t.Fatalf("second wake read %d", n)
	}
	got := e.reqs[Batch:]
	if isCatchUp(got[0]) || !strings.Contains(got[0].Prompt, "Why?") {
		t.Errorf("the waiting session was not read first")
	}
	for i, r := range got[1:] {
		if !isCatchUp(r) {
			t.Errorf("read %d of the second wake is not the catch-up", i+2)
		}
	}
}

func TestTheCatchUpKeepsTheDailyLimit(t *testing.T) {
	e := newEnv(t, func(r Request) (Result, error) {
		res, _ := twoMemories(r)
		res.TokensIn = 600 // with 200 out: the second read crosses 1000
		return res, nil
	})
	e.cfg.DailyTokens = 1000
	ctx := context.Background()
	e.skippedLong(t)
	if n, _ := e.eng.Wake(ctx); n != 2 {
		t.Fatalf("read %d; the second crosses the limit", n)
	}
	if st := e.eng.Status(ctx); !strings.Contains(st.LastError, "limit") || st.CatchUp == nil || st.CatchUp.Done != 2 {
		t.Fatalf("status: %+v %+v", st.LastError, st.CatchUp)
	}
	if n, _ := e.eng.Wake(ctx); n != 0 {
		t.Fatalf("read %d over the limit", n)
	}
	e.now = e.now.Add(25 * time.Hour)
	if n, _ := e.eng.Wake(ctx); n != 2 {
		t.Errorf("read %d after the day rolled over", n)
	}
}

func TestTheCatchUpReadsNothingWhileItIsOff(t *testing.T) {
	e := newEnv(t, twoMemories)
	ctx := context.Background()
	e.skippedLong(t)
	for _, auto := range []*bool{nil, new(bool)} {
		e.cfg = config.BrainConfig{Auto: auto, Since: e.cfg.Since}
		if n, _ := e.eng.Wake(ctx); n != 0 || e.calls != 0 {
			t.Fatalf("auto %v: read %d", auto, n)
		}
		if st := e.eng.Status(ctx); st.CatchUp != nil {
			t.Errorf("auto %v: catch-up in the status: %+v", auto, st.CatchUp)
		}
	}
}

func TestTheCatchUpStatusCountsReads(t *testing.T) {
	e := newEnv(t, twoMemories) // 4,200 tokens a read
	ctx := context.Background()
	e.skippedLong(t)
	e.cfg.DailyTokens = 8_000
	if err := e.eng.FindGaps(ctx); err != nil {
		t.Fatal(err)
	}
	total := gaps(t, e)[0].ReadsTotal
	st := e.eng.Status(ctx)
	// Before any read, a full read's estimate: 6,000 + 4,300 + 400 tokens.
	wantDays := (total*10_700 + 7_999) / 8_000
	if st.CatchUp == nil || st.CatchUp.Kind != "skipped" || st.CatchUp.Done != 0 || st.CatchUp.Total != total || st.CatchUp.DaysLeft != wantDays {
		t.Fatalf("catch-up before reading: %+v, want 0/%d, %d days", st.CatchUp, total, wantDays)
	}
	_, _ = e.eng.Wake(ctx) // two reads, then the limit
	st = e.eng.Status(ctx)
	wantDays = ((total-2)*4_200 + 7_999) / 8_000
	if st.CatchUp == nil || st.CatchUp.Done != 2 || st.CatchUp.Total != total || st.CatchUp.DaysLeft != wantDays {
		t.Fatalf("catch-up after two reads: %+v, want 2/%d, %d days", st.CatchUp, total, wantDays)
	}
}

func TestAShortTailWaitsForMoreUnlessTheSessionEnded(t *testing.T) {
	e := newEnv(t, twoMemories)
	ctx := context.Background()
	e.session(t, "s", "p", 20*time.Minute, [2]string{"Why is the cache test flaky?", long})
	if n, _ := e.eng.Wake(ctx); n != 1 {
		t.Fatalf("first read: %d", n)
	}
	// A short exchange after it: held, not read, and the cursor stays.
	e.now = e.now.Add(time.Hour)
	tail := e.session(t, "s", "p", 20*time.Minute, [2]string{"ok, and the retry?", "Retries stay at three."})
	cursor := runsOf(t, e, "s")[0].ThroughEventID
	if n, _ := e.eng.Wake(ctx); n != 0 || e.calls != 1 {
		t.Fatalf("the short tail was read: %d", n)
	}
	if c, _ := store.BrainCandidates(ctx, e.st.DB(), 0, e.now.UnixMilli(), 10); len(c) != 0 {
		t.Fatalf("a held tail is looked at again on every wake: %+v", c)
	}
	if st := e.eng.Status(ctx); st.Pending != 0 {
		t.Errorf("a held tail counts as waiting: %d", st.Pending)
	}
	runs := runsOf(t, e, "s")
	if last := runs[len(runs)-1]; last.Status != store.BrainRunSkipped || last.FromEventID != cursor {
		t.Fatalf("held: %+v", last)
	}
	// More prose comes: the tail is read with it.
	e.now = e.now.Add(time.Hour)
	e.session(t, "s", "p", 20*time.Minute, [2]string{"And the timeout?", long})
	if n, _ := e.eng.Wake(ctx); n != 1 {
		t.Fatalf("read %d after more prose", n)
	}
	if p := e.reqs[1].Prompt; !strings.Contains(p, "Retries stay at three.") || !strings.Contains(p, "And the timeout?") || strings.Contains(p, "flaky") {
		t.Errorf("the tail was not read with what came next: %q", p)
	}
	if runs := runsOf(t, e, "s"); runs[len(runs)-1].FromEventID != cursor || runs[len(runs)-1].ThroughEventID <= tail {
		t.Errorf("runs: %+v", runs)
	}

	// A session that ended with a short tail: marked read, nothing waits.
	e.now = e.now.Add(time.Hour)
	end := e.session(t, "s", "p", 20*time.Minute, [2]string{"thanks", "Done."})
	if n, _ := e.eng.Wake(ctx); n != 0 {
		t.Fatalf("read %d", n)
	}
	if _, err := e.st.DB().Exec(`UPDATE sessions SET status = 'ended' WHERE session_id = 's'`); err != nil {
		t.Fatal(err)
	}
	if n, _ := e.eng.Wake(ctx); n != 0 || e.calls != 2 {
		t.Fatalf("the ended tail was read: %d", n)
	}
	if c, _ := store.BrainCandidates(ctx, e.st.DB(), 0, e.now.UnixMilli(), 10); len(c) != 0 {
		t.Errorf("an ended session's short tail still waits: %+v", c)
	}
	if runs := runsOf(t, e, "s"); runs[len(runs)-1].ThroughEventID != end {
		t.Errorf("the ended tail was not marked read: %+v", runs[len(runs)-1])
	}
}
