package brain

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/store"
)

// While claude is asked about a session, the status names it — its title,
// agent, project and when it last did something — and a progress frame
// says so before and after; once the read is over it is gone.
func TestTheStatusNamesTheSessionBeingRead(t *testing.T) {
	ctx := context.Background()
	var during Status
	var e *env
	e = newEnv(t, func(r Request) (Result, error) {
		during = e.eng.Status(ctx)
		return twoMemories(r)
	})
	e.session(t, "s1", "acme-api", 20*time.Minute, [2]string{"Why is   the cache test\nflaky?", long})
	sub := e.eng.Bus.Subscribe(16)
	defer sub.Unsubscribe()
	if _, err := e.eng.Wake(ctx); err != nil {
		t.Fatal(err)
	}
	r := during.Reading
	if r == nil || r.SessionID != "s1" || r.Project != "acme-api" || r.Agent != "claude" ||
		r.Title != "Why is the cache test flaky?" || r.StartedAt != t0.UnixMilli() || r.LastEventAt != t0.Add(-20*time.Minute).UnixMilli() {
		t.Fatalf("reading while the read runs: %+v", r)
	}
	if st := e.eng.Status(ctx); st.Reading != nil {
		t.Errorf("still reading after the read: %+v", st.Reading)
	}
	ops := []string{}
	var frames []map[string]any
	for len(sub.C) > 0 {
		if f := <-sub.C; f.Type == bus.FrameBrain {
			d := f.Data.(map[string]any)
			frames = append(frames, d)
			op := d["op"].(string)
			if ph, ok := d["phase"].(string); ok {
				op += ":" + ph
			}
			ops = append(ops, op)
		}
	}
	// The read's start, each memory, then the read's end with the count:
	// the end comes last, so a screen that waits for it has them all.
	if strings.Join(ops, ",") != "progress:start,added,added,progress:done" {
		t.Fatalf("frames: %v", ops)
	}
	if s := frames[0]; s["session"] != "s1" || s["project"] != "acme-api" || s["agent"] != "claude" {
		t.Errorf("start frame: %v", s)
	}
	runs, _ := store.LastBrainRuns(ctx, e.st.DB(), 1)
	if len(runs) != 1 {
		t.Fatalf("runs: %+v", runs)
	}
	for _, a := range frames[1:3] {
		if a["run"] != runs[0].ID || a["agent"] != "claude" || a["session"] != "s1" {
			t.Errorf("added frame: %v", a)
		}
	}
	if d := frames[3]; d["run"] != runs[0].ID || d["added"] != 2 || d["session"] != "s1" || d["project"] != "acme-api" || d["agent"] != "claude" {
		t.Errorf("done frame: %v", d)
	}
	// The agent read is on the status's faces, for a day.
	if a := e.eng.Status(ctx).Agents24h; len(a) != 1 || a[0].Agent != "claude" || a[0].Sessions != 1 || a[0].LastAt != t0.UnixMilli() {
		t.Errorf("agents_24h: %+v", a)
	}

	// The session's own name wins over its first prompt.
	if _, err := e.st.DB().Exec(`UPDATE sessions SET title = 'Flaky cache test' WHERE session_id = 's1'`); err != nil {
		t.Fatal(err)
	}
	e.now = e.now.Add(time.Hour)
	e.session(t, "s1", "acme-api", 15*time.Minute, [2]string{"And retries?", long})
	if _, err := e.eng.Wake(ctx); err != nil {
		t.Fatal(err)
	}
	if during.Reading == nil || during.Reading.Title != "Flaky cache test" {
		t.Errorf("titled session: %+v", during.Reading)
	}
	runs, _ = store.LastBrainRuns(ctx, e.st.DB(), 1)
	if len(runs) != 1 || runs[0].Title != "Flaky cache test" || runs[0].Agent != "claude" {
		t.Errorf("a recent read names its session: %+v", runs)
	}
}

// The build counts every session in reach once — read, or quiet and
// waiting — with the memories kept, per project; a live session is not
// counted until it goes quiet, and one from before the reach not at all.
func TestTheBuildCountsWhatIsReadAndWhatWaitsPerProject(t *testing.T) {
	ctx := context.Background()
	// Each read keeps two memories of its own: the same titles twice in a
	// project would be near duplicates, and the second pair left out.
	reads := 0
	e := newEnv(t, func(r Request) (Result, error) {
		reads++
		res, err := twoMemories(r)
		for i := range res.Memories {
			res.Memories[i].Title = fmt.Sprintf("Read %d keeps %s", reads, []string{"alpha", "beta"}[i])
		}
		return res, err
	})
	e.session(t, "a1", "acme-api", 1*time.Hour, [2]string{"q", long})
	e.session(t, "a2", "acme-api", 2*time.Hour, [2]string{"q", long})
	e.session(t, "a3", "acme-api", 3*time.Hour, [2]string{"q", "too short"})
	for _, id := range []string{"w1", "w2", "w3", "w4"} {
		e.session(t, id, "web", 5*time.Hour, [2]string{"q", long})
	}
	e.session(t, "live", "web", time.Minute, [2]string{"q", long})
	e.session(t, "old", "web", 72*time.Hour, [2]string{"q", long})

	st := e.eng.Status(ctx)
	b := st.Build
	if b == nil || b.Sessions != 7 || b.Read != 0 || b.Memories != 0 || b.From != e.cfg.Since {
		t.Fatalf("before any read: %+v", b)
	}
	// One wake reads the four newest that have prose (the short one is
	// recorded as skipped on the way, without a call).
	if n, _ := e.eng.Wake(ctx); n != Batch {
		t.Fatalf("read %d", n)
	}
	b = e.eng.Status(ctx).Build
	// Read: a1, a2, a3 (skipped) and two of web's; waiting: two of web's.
	if b.Sessions != 7 || b.Read != 5 || b.Memories != 8 || st.Pending != 7 {
		t.Fatalf("after a wake: %+v (pending before %d)", b, st.Pending)
	}
	want := []BuildSource{{Project: "web", Read: 2, Pending: 2, Memories: 4}, {Project: "acme-api", Read: 3, Memories: 4}}
	got, _ := json.Marshal(b.Sources)
	exp, _ := json.Marshal(want)
	if string(got) != string(exp) {
		t.Errorf("sources:\n got %s\nwant %s", got, exp)
	}
	// New prose in a read session: it waits again, counted once. An hour on,
	// the live session has gone quiet and joins.
	e.now = e.now.Add(time.Hour)
	e.session(t, "a1", "acme-api", 15*time.Minute, [2]string{"more", long})
	b = e.eng.Status(ctx).Build
	if b.Sessions != 8 || b.Read != 4 || b.Memories != 8 {
		t.Errorf("a read session waiting again: %+v", b)
	}

	// Off: no build.
	off := false
	e.cfg.Auto = &off
	if st := e.eng.Status(ctx); st.Build != nil {
		t.Errorf("off, a build: %+v", st.Build)
	}
}

// The status says where the build is and what it has given, from counts
// only: the read's phase and passages while claude is asked, the stage,
// the cost claude reported, today's new memories, the graph's topics and
// links, the last read, and how many sessions were handed memories.
func TestTheStatusSaysTheStageAndWhatTheBrainGives(t *testing.T) {
	ctx := context.Background()
	var during Status
	var e *env
	e = newEnv(t, func(r Request) (Result, error) {
		during = e.eng.Status(ctx)
		return twoMemories(r)
	})
	handoff := true
	e.eng.HandoffOn = func() bool { return handoff }
	e.eng.ClaudeFound = func() bool { return true }
	if st := e.eng.Status(ctx); st.Stage != StageUpToDate || st.LastRead != 0 || st.NewToday != 0 {
		t.Fatalf("empty: %+v", st)
	}
	e.session(t, "s1", "acme-api", 20*time.Minute, [2]string{"q", long}, [2]string{"q2", long})
	e.session(t, "s2", "web", 30*time.Minute, [2]string{"q", long})
	if st := e.eng.Status(ctx); st.Stage != StageWaiting || st.Pending != 2 {
		t.Fatalf("waiting: stage %q, pending %d", st.Stage, st.Pending)
	}
	if _, err := e.eng.Wake(ctx); err != nil {
		t.Fatal(err)
	}
	if during.Stage != StageExtracting || during.Reading == nil || during.Reading.Phase != PhaseExtracting || during.Reading.Passages != 2 {
		t.Fatalf("during the read of s2 (the last): stage %q, reading %+v", during.Stage, during.Reading)
	}
	st := e.eng.Status(ctx)
	if st.Stage != StageUpToDate || st.LastRead != t0.UnixMilli() || st.NewToday != 4 || st.Topics != 3 || st.Links == 0 {
		t.Errorf("after: stage %q, last %d, today %d, topics %d, links %d", st.Stage, st.LastRead, st.NewToday, st.Topics, st.Links)
	}
	if st.SpentUSD < 0.0079 || st.SpentUSD > 0.0081 || st.Spent != 8400 {
		t.Errorf("spent %d tokens, $%v", st.Spent, st.SpentUSD)
	}
	if !st.Handoff.On || st.Handoff.Sessions != 0 {
		t.Errorf("handoff: %+v", st.Handoff)
	}
	if err := store.SetHandoffBrain(ctx, e.st.DB(), "s1", 3); err != nil {
		t.Fatal(err)
	}
	handoff = false
	if h := e.eng.Status(ctx).Handoff; h.On || h.Sessions != 1 || h.Memories != 3 || h.Sessions24h != 1 || h.Memories24h != 3 {
		t.Errorf("handed once: %+v", h)
	}

	// Waiting with today's tokens used is the limit; no claude says so; off is off.
	e.cfg.DailyTokens = 1000
	e.now = e.now.Add(time.Hour)
	e.session(t, "s3", "web", 15*time.Minute, [2]string{"q", long})
	if st := e.eng.Status(ctx); st.Stage != StageLimit {
		t.Errorf("over the limit: %q", st.Stage)
	}
	e.eng.ClaudeFound = func() bool { return false }
	if st := e.eng.Status(ctx); st.Stage != StageNoClaude {
		t.Errorf("no claude: %q", st.Stage)
	}
	off := false
	e.cfg.Auto = &off
	if st := e.eng.Status(ctx); st.Stage != StageOff {
		t.Errorf("off: %q", st.Stage)
	}
}

// A backfill's catch-up is on the status while sessions from before the
// yes wait: reads done of all, and days left from the measured reads at the
// daily limit. Without a backfill reaching back, or with nothing of it
// left, there is none — a fresh session waiting is not a catch-up.
func TestTheStatusCarriesTheBackfillsCatchUp(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t, twoMemories)
	e.session(t, "new", "web", time.Hour, [2]string{"q", long})
	if cu := e.eng.Status(ctx).CatchUp; cu != nil {
		t.Fatalf("no backfill, no catch-up: %+v", cu)
	}
	e.cfg.BackfillSince = e.now.Add(-30 * 24 * time.Hour).UnixMilli()
	e.session(t, "old1", "acme-api", 5*24*time.Hour, [2]string{"q", long})
	e.session(t, "old2", "acme-api", 6*24*time.Hour, [2]string{"q", long})
	cu := e.eng.Status(ctx).CatchUp
	if cu == nil || cu.Kind != CatchUpBackfill || cu.Done != 0 || cu.Total != 2 || cu.DaysLeft != 0 {
		t.Fatalf("before any read: %+v (no read measured, so no days left)", cu)
	}
	if n, err := e.eng.Wake(ctx); err != nil || n != 3 {
		t.Fatalf("wake: %d %v", n, err)
	}
	if cu := e.eng.Status(ctx).CatchUp; cu != nil {
		t.Fatalf("all of it read: %+v", cu)
	}
	e.session(t, "old3", "web", 7*24*time.Hour, [2]string{"q", long})
	e.session(t, "new2", "web", time.Hour, [2]string{"q", long})
	cu = e.eng.Status(ctx).CatchUp
	// One left at 4,200 tokens a read (twoMemories) against 300k a day.
	if cu == nil || cu.Done != 2 || cu.Total != 3 || cu.DaysLeft != 1 {
		t.Fatalf("one more old session: %+v", cu)
	}
	e.cfg.DailyTokens = 1000
	if cu := e.eng.Status(ctx).CatchUp; cu == nil || cu.DaysLeft != 5 {
		t.Fatalf("4,200 tokens at 1,000 a day: %+v", cu)
	}
}
