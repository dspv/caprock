package rollup

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/cost"
	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/store"
)

func newRecorder(t *testing.T) (*Recorder, *bus.Subscriber) {
	t.Helper()
	st, err := store.Open(context.Background(), ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	tb, err := cost.Embedded()
	if err != nil {
		t.Fatal(err)
	}
	b := bus.New()
	sub := b.Subscribe(64)
	r := New(st, tb, b, nil)
	r.Location = time.UTC
	return r, sub
}

func drain(sub *bus.Subscriber) []bus.Frame {
	var out []bus.Frame
	for {
		select {
		case f := <-sub.C:
			out = append(out, f)
		default:
			return out
		}
	}
}

func TestRecordPricesTurnAndRollsUp(t *testing.T) {
	ctx := context.Background()
	r, sub := newRecorder(t)
	ev := &event.Event{
		SessionID: "s1", Source: event.SourceTranscript, Kind: event.KindTurnAssistant, Key: "u1",
		Ts: time.Date(2026, 8, 18, 12, 0, 0, 0, time.UTC), Model: "claude-opus-5",
		Tokens: &event.TokenDelta{In: 1_000_000, Out: 0},
	}
	res, err := r.Record(ctx, ev, SessionInfo{Cwd: "/home/u/proj"})
	if err != nil {
		t.Fatal(err)
	}
	if !res.Stored || !res.Priced || ev.CostUSD == nil || *ev.CostUSD != 5.0 {
		t.Fatalf("result: %+v cost=%v", res, ev.CostUSD)
	}
	if res.Stats.Turns != 1 || res.Stats.TokensIn != 1_000_000 || res.Stats.CostUSD != 5.0 {
		t.Fatalf("stats: %+v", res.Stats)
	}
	if res.Session.Project != "proj" || res.Session.Model != "claude-opus-5" || !res.Session.HasTranscript {
		t.Fatalf("session: %+v", res.Session)
	}
	d, _ := store.Daily(ctx, r.Store.DB(), "2026-08-18")
	if len(d) != 1 || d[0].Sessions != 1 || d[0].CostUSD != 5.0 || d[0].Project != "proj" {
		t.Fatalf("daily: %+v", d)
	}
	frames := drain(sub)
	if len(frames) != 2 || frames[0].Type != bus.FrameEvent || frames[1].Type != bus.FrameSession {
		t.Fatalf("frames: %+v", frames)
	}
	// Duplicate: no-op, no frames, no double count.
	dup := *ev
	dup.ID, dup.CostUSD = 0, nil
	res, err = r.Record(ctx, &dup, SessionInfo{})
	if err != nil || res.Stored {
		t.Fatalf("dup: %+v %v", res, err)
	}
	if len(drain(sub)) != 0 {
		t.Fatal("dup published frames")
	}
	st, _ := store.GetStats(ctx, r.Store.DB(), "s1")
	if st.Turns != 1 {
		t.Fatalf("double counted: %+v", st)
	}
	// Second turn: sessions count stays 1 in daily.
	ev2 := *ev
	ev2.ID, ev2.Key, ev2.CostUSD = 0, "u2", nil
	if _, err := r.Record(ctx, &ev2, SessionInfo{}); err != nil {
		t.Fatal(err)
	}
	d, _ = store.Daily(ctx, r.Store.DB(), "2026-08-18")
	if d[0].Sessions != 1 || d[0].CostUSD != 10.0 {
		t.Fatalf("daily after 2nd turn: %+v", d)
	}
}

func TestRecordToolCallsAndFiles(t *testing.T) {
	ctx := context.Background()
	r, _ := newRecorder(t)
	mk := func(key, tool, path string) *event.Event {
		payload, _ := json.Marshal(map[string]any{"tool_name": tool, "tool_input": map[string]string{"file_path": path}})
		return &event.Event{SessionID: "s1", Source: event.SourceHook, Kind: event.KindToolPre, Tool: tool, Key: key, Payload: payload}
	}
	for _, e := range []*event.Event{mk("t1", "Edit", "/a.go"), mk("t2", "Edit", "/a.go"), mk("t3", "Write", "/b.go"), mk("t4", "Bash", "")} {
		if _, err := r.Record(ctx, e, SessionInfo{Cwd: "/p"}); err != nil {
			t.Fatal(err)
		}
	}
	st, _ := store.GetStats(ctx, r.Store.DB(), "s1")
	if st.ToolCalls != 4 || st.FilesTouched != 2 {
		t.Fatalf("stats: %+v", st)
	}
	s, _ := store.GetSession(ctx, r.Store.DB(), "s1")
	if !s.HasHooks || s.HasTranscript || s.Status != store.StatusActive {
		t.Fatalf("session: %+v", s)
	}
}

func TestUnknownModelLeavesCostNil(t *testing.T) {
	r, _ := newRecorder(t)
	ev := &event.Event{SessionID: "s", Source: event.SourceTranscript, Kind: event.KindTurnAssistant, Model: "mystery-9", Tokens: &event.TokenDelta{In: 5}}
	res, err := r.Record(context.Background(), ev, SessionInfo{})
	if err != nil || res.Priced || ev.CostUSD != nil {
		t.Fatalf("unknown model priced: %+v %v", res, ev.CostUSD)
	}
}

func TestThrottleRecorded(t *testing.T) {
	ctx := context.Background()
	r, _ := newRecorder(t)
	ev := &event.Event{SessionID: "s", Source: event.SourceHook, Kind: event.KindThrottle, Payload: json.RawMessage(`{"error":"rate_limit"}`)}
	if _, err := r.Record(ctx, ev, SessionInfo{}); err != nil {
		t.Fatal(err)
	}
	n, err := store.CountThrottles(ctx, r.Store.DB(), 0, "")
	if err != nil || n != 1 {
		t.Fatalf("throttle not recorded: %d %v", n, err)
	}
}

// A SessionEnd hook ends the session at the moment the user leaves it. Before
// this the only path to 'ended' was the staleness sweep, so a session closed at
// noon still counted as live until the small hours.
func TestSessionEndEndsSessionAndRevives(t *testing.T) {
	ctx := context.Background()
	r, _ := newRecorder(t)
	base := time.Date(2026, 8, 18, 12, 0, 0, 0, time.UTC)
	if _, err := r.Record(ctx, &event.Event{SessionID: "s", Source: event.SourceHook, Kind: event.KindTurnUser, Ts: base}, SessionInfo{}); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Record(ctx, &event.Event{SessionID: "s", Source: event.SourceHook, Kind: event.KindSessionEnd, Ts: base.Add(time.Minute)}, SessionInfo{}); err != nil {
		t.Fatal(err)
	}
	s, _ := store.GetSession(ctx, r.Store.DB(), "s")
	if s.Status != store.StatusEnded {
		t.Fatalf("after SessionEnd: status %s, want ended", s.Status)
	}
	// Ending is not a tombstone: a newer event means the session is alive
	// again, which is what makes a wrong guess cheap.
	if _, err := r.Record(ctx, &event.Event{SessionID: "s", Source: event.SourceHook, Kind: event.KindTurnUser, Ts: base.Add(2 * time.Minute)}, SessionInfo{}); err != nil {
		t.Fatal(err)
	}
	if s, _ = store.GetSession(ctx, r.Store.DB(), "s"); s.Status != store.StatusActive {
		t.Fatalf("after a later event: status %s, want active", s.Status)
	}
}

func TestMarkIdle(t *testing.T) {
	ctx := context.Background()
	r, sub := newRecorder(t)
	base := time.Date(2026, 8, 18, 12, 0, 0, 0, time.UTC)
	r.Now = func() time.Time { return base }
	if _, err := r.Record(ctx, &event.Event{SessionID: "s", Source: event.SourceHook, Kind: event.KindTurnUser, Ts: base}, SessionInfo{}); err != nil {
		t.Fatal(err)
	}
	drain(sub)
	r.Now = func() time.Time { return base.Add(10 * time.Minute) }
	if err := r.MarkIdle(ctx, 5*time.Minute, 0); err != nil {
		t.Fatal(err)
	}
	s, _ := store.GetSession(ctx, r.Store.DB(), "s")
	if s.Status != store.StatusIdle {
		t.Fatalf("status %s", s.Status)
	}
	if f := drain(sub); len(f) != 1 || f[0].Type != bus.FrameSession {
		t.Fatalf("frames %+v", f)
	}
}

// A working day has interruptions, and none of them mean the session is over.
//
// v0.44.3 set the end threshold to one hour on the reasoning that "an hour
// outlasts lunch". An hour *is* lunch: the first user to leave his terminal and
// come back found his session closed. On the machine that was checked against,
// 44 sessions had paused for over an hour and then carried on, 86 of those
// pauses between one and three hours.
//
// The threshold only exists for a session that ended without saying so —
// kill -9, a closed terminal, a crashed host. SessionEnd handles every ordinary
// ending immediately, so this can afford to be slow.
func TestALunchBreakDoesNotEndASession(t *testing.T) {
	ctx := context.Background()
	r, sub := newRecorder(t)
	base := time.Date(2026, 8, 18, 12, 0, 0, 0, time.UTC)
	r.Now = func() time.Time { return base }
	if _, err := r.Record(ctx, &event.Event{SessionID: "lunch", Source: event.SourceHook, Kind: event.KindTurnUser, Ts: base}, SessionInfo{}); err != nil {
		t.Fatal(err)
	}
	drain(sub)

	// The default the daemon applies. Named here so a change to it has to
	// change this test too, and whoever changes it reads why it is eight.
	const endAfter = 24 * time.Hour

	for _, away := range []time.Duration{
		time.Hour,                    // lunch
		90 * time.Minute,             // lunch and a walk
		3 * time.Hour,                // a long meeting
		7*time.Hour + 30*time.Minute, // most of a day on something else
	} {
		r.Now = func() time.Time { return base.Add(away) }
		if err := r.MarkIdle(ctx, 5*time.Minute, endAfter); err != nil {
			t.Fatal(err)
		}
		s, _ := store.GetSession(ctx, r.Store.DB(), "lunch")
		if s.Status == store.StatusEnded {
			t.Fatalf("a %s absence ended the session", away)
		}
	}

	// Long enough that nobody is coming back to it today.
	r.Now = func() time.Time { return base.Add(25 * time.Hour) }
	if err := r.MarkIdle(ctx, 5*time.Minute, endAfter); err != nil {
		t.Fatal(err)
	}
	s, _ := store.GetSession(ctx, r.Store.DB(), "lunch")
	if s.Status != store.StatusEnded {
		t.Errorf("after 25h the backstop should have ended it, status %s", s.Status)
	}
}

// And if it was wrong, the session comes back the moment its owner types.
func TestAWronglyEndedSessionRevivesOnItsNextEvent(t *testing.T) {
	ctx := context.Background()
	r, sub := newRecorder(t)
	base := time.Date(2026, 8, 18, 12, 0, 0, 0, time.UTC)
	r.Now = func() time.Time { return base }
	if _, err := r.Record(ctx, &event.Event{SessionID: "back", Source: event.SourceHook, Kind: event.KindTurnUser, Ts: base}, SessionInfo{}); err != nil {
		t.Fatal(err)
	}
	drain(sub)

	r.Now = func() time.Time { return base.Add(25 * time.Hour) }
	if err := r.MarkIdle(ctx, 5*time.Minute, 24*time.Hour); err != nil {
		t.Fatal(err)
	}
	if s, _ := store.GetSession(ctx, r.Store.DB(), "back"); s.Status != store.StatusEnded {
		t.Fatalf("setup: status %s, want ended", s.Status)
	}

	later := base.Add(10 * time.Hour)
	r.Now = func() time.Time { return later }
	if _, err := r.Record(ctx, &event.Event{SessionID: "back", Source: event.SourceHook, Kind: event.KindTurnUser, Ts: later}, SessionInfo{}); err != nil {
		t.Fatal(err)
	}
	if s, _ := store.GetSession(ctx, r.Store.DB(), "back"); s.Status != store.StatusActive {
		t.Errorf("typing in an ended session left it %s", s.Status)
	}
}

// A session that carries on into the next day counts on both days.
//
// The daily "sessions" column used to be incremented when a session recorded
// its first turn *ever*, so a session begun yesterday added nothing to today —
// and a day whose work was all continuations read zero sessions beside real
// spend. Four of eight days on the owner's database read exactly that.
func TestASessionSpanningMidnightCountsOnBothDays(t *testing.T) {
	ctx := context.Background()
	r, _ := newRecorder(t)

	// UTC, because newRecorder pins the recorder's location to it — a local
	// time here would land on whichever side of midnight the test machine's
	// offset put it, which is how the first version of this test lied.
	for i, ts := range []time.Time{
		time.Date(2026, 8, 18, 23, 50, 0, 0, time.UTC),
		time.Date(2026, 8, 19, 0, 10, 0, 0, time.UTC), // same session, next day
		time.Date(2026, 8, 19, 0, 20, 0, 0, time.UTC), // and again, same day
	} {
		ev := &event.Event{
			SessionID: "night-owl", Source: event.SourceTranscript,
			Kind: event.KindTurnAssistant, Key: fmt.Sprintf("k%d", i),
			Ts: ts, Model: "claude-opus-5",
			Tokens: &event.TokenDelta{In: 1_000_000, Out: 0},
		}
		if _, err := r.Record(ctx, ev, SessionInfo{Cwd: "/home/u/proj"}); err != nil {
			t.Fatal(err)
		}
	}

	d, err := store.Daily(ctx, r.Store.DB(), "2026-08-18")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]int64{}
	for _, row := range d {
		got[row.Day] += row.Sessions
	}
	if got["2026-08-18"] != 1 {
		t.Errorf("18th counted %d sessions, want 1", got["2026-08-18"])
	}
	if got["2026-08-19"] != 1 {
		t.Errorf("19th counted %d sessions, want 1 — the same session working on a second day is a session that day", got["2026-08-19"])
	}
}

// The whole /clear sequence as Claude Code emits it: the old session's
// SessionEnd, then a SessionStart carrying the NEW id and source=clear, both
// on the same pid. Afterwards exactly one session is live.
//
// Keyed off the end event instead, this retired the wrong one — the SessionEnd
// payload carries the id being replaced, so "keep this session" named the
// session that was going away.
func TestClearLeavesOneLiveSession(t *testing.T) {
	ctx := context.Background()
	r, _ := newRecorder(t)
	base := time.Date(2026, 8, 18, 12, 0, 0, 0, time.UTC)
	const pid = 4242

	if _, err := r.Record(ctx, &event.Event{SessionID: "old", Source: event.SourceHook, Kind: event.KindTurnUser, Ts: base}, SessionInfo{PID: pid}); err != nil {
		t.Fatal(err)
	}
	// The /clear itself: recorded, and it must not end the session by itself.
	if _, err := r.Record(ctx, &event.Event{SessionID: "old", Source: event.SourceHook, Kind: event.KindContextClear, Ts: base.Add(time.Minute)}, SessionInfo{PID: pid}); err != nil {
		t.Fatal(err)
	}
	// The replacement announces itself.
	if _, err := r.Record(ctx, &event.Event{SessionID: "new", Source: event.SourceHook, Kind: event.KindAgentSpawn, Ts: base.Add(2 * time.Minute)}, SessionInfo{PID: pid, ReplacesPID: true}); err != nil {
		t.Fatal(err)
	}

	old, err := store.GetSession(ctx, r.Store.DB(), "old")
	if err != nil {
		t.Fatal(err)
	}
	if old.Status != store.StatusEnded {
		t.Errorf("the cleared session is %q, want ended — it would never close, since its pid is the live one now serving its replacement", old.Status)
	}
	fresh, err := store.GetSession(ctx, r.Store.DB(), "new")
	if err != nil {
		t.Fatal(err)
	}
	if fresh.Status != store.StatusActive {
		t.Errorf("the session that replaced it is %q, want active", fresh.Status)
	}
}

// A /clear on its own is not an ending. Only the SessionStart that follows
// retires the old row, and until it arrives the session stays live.
func TestAClearAloneDoesNotEndTheSession(t *testing.T) {
	ctx := context.Background()
	r, _ := newRecorder(t)
	base := time.Date(2026, 8, 18, 12, 0, 0, 0, time.UTC)
	if _, err := r.Record(ctx, &event.Event{SessionID: "s", Source: event.SourceHook, Kind: event.KindTurnUser, Ts: base}, SessionInfo{PID: 7}); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Record(ctx, &event.Event{SessionID: "s", Source: event.SourceHook, Kind: event.KindContextClear, Ts: base.Add(time.Minute)}, SessionInfo{PID: 7}); err != nil {
		t.Fatal(err)
	}
	s, err := store.GetSession(ctx, r.Store.DB(), "s")
	if err != nil {
		t.Fatal(err)
	}
	if s.Status == store.StatusEnded {
		t.Fatal("a /clear retired the session its owner is still sitting in")
	}
}
