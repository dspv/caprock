package rollup

import (
	"context"
	"encoding/json"
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
	n, err := store.CountThrottles(ctx, r.Store.DB(), 0)
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
