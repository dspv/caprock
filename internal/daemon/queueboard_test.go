package daemon

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/api"
	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/store"
)

func boardSession(t *testing.T, d *Daemon, id, agent, root string, owned bool) {
	t.Helper()
	ctx := context.Background()
	now := time.Now().UnixMilli()
	if err := store.UpsertSession(ctx, d.store.DB(), id, store.SessionPatch{Agent: agent, Cwd: root, Project: "proj", StartedAt: now, LastEventAt: now}); err != nil {
		t.Fatal(err)
	}
	o := 0
	if owned {
		o = 1
	}
	if _, err := d.store.DB().Exec(`UPDATE sessions SET repo_root = ?, owned = ? WHERE session_id = ?`, root, o, id); err != nil {
		t.Fatal(err)
	}
}

func boundAt(t *testing.T, d *Daemon, id string, kind event.Kind, at time.Time, payload string) {
	t.Helper()
	if payload == "" {
		payload = "{}"
	}
	ev := &event.Event{SessionID: id, Source: event.SourceHook, Kind: kind, Ts: at, Payload: []byte(payload)}
	if _, err := store.InsertEvent(context.Background(), d.store.DB(), ev); err != nil {
		t.Fatal(err)
	}
}

// The board: a working Claude Code session with two queued messages gets the
// current turn's remaining time and each message's place and range from the
// project's history; another agent gets a note instead of a number.
func TestBoardEstimatesFromProjectHistory(t *testing.T) {
	q, f, d := newTestQueue(t)
	ctx := context.Background()
	now := time.Now().Truncate(time.Millisecond)
	q.now = func() time.Time { return now }

	// History: six finished turns of 60, 120, 180, 240, 300, 360 s in /r,
	// in a session Caprock did not start.
	boardSession(t, d, "hist", "claude", "/r", false)
	at := now.Add(-10 * time.Hour)
	for i := 1; i <= 6; i++ {
		boundAt(t, d, "hist", event.KindTurnUser, at, "")
		at = at.Add(time.Duration(i*60) * time.Second)
		boundAt(t, d, "hist", event.KindAgentStop, at, "")
		at = at.Add(time.Minute)
	}

	f.owned["s1"] = agents.AgentClaude
	boardSession(t, d, "s1", "claude", "/r", true)
	boundAt(t, d, "s1", event.KindTurnUser, now.Add(-30*time.Second), `{"prompt":"go"}`)
	for _, m := range []string{"second", "third"} {
		if _, err := store.AddQueued(ctx, d.store.DB(), "s1", m, now); err != nil {
			t.Fatal(err)
		}
	}
	f.owned["cx"] = agents.AgentCodex
	boardSession(t, d, "cx", "codex", "/r", true)

	b, err := q.Board(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(b.Sessions) != 2 || b.Sessions[0].SessionID != "s1" {
		t.Fatalf("sessions = %+v (the working one first)", b.Sessions)
	}
	s := b.Sessions[0]
	if s.Waiting != api.WaitingTurn || s.TurnStartedAt != now.Add(-30*time.Second).UnixMilli() {
		t.Fatalf("s1 waiting %q started %d", s.Waiting, s.TurnStartedAt)
	}
	// Six turns: p25 135 s, median 210 s, p75 285 s.
	if s.Estimate == nil || s.Estimate.Turns != 6 || s.Estimate.MedianMs != 210000 {
		t.Fatalf("estimate = %+v", s.Estimate)
	}
	if s.TurnLeft == nil || s.TurnLeft.MidMs != 180000 {
		t.Fatalf("turn left = %+v, want 180 s (210 − 30)", s.TurnLeft)
	}
	if len(s.Queue) != 2 || s.Queue[1].Position != 2 || s.Queue[0].Start.MidMs != 180000 || s.Queue[1].Start.MidMs != 390000 || s.Queue[1].Finish.MidMs != 600000 {
		t.Fatalf("queue = %+v %+v", s.Queue[0], s.Queue[1])
	}
	if s.FreeIn == nil || s.FreeIn.MidMs != 600000 {
		t.Fatalf("free in = %+v", s.FreeIn)
	}
	cx := b.Sessions[1]
	if cx.Estimate != nil || !strings.Contains(cx.EstimateNote, "codex") || cx.FreeIn != nil {
		t.Fatalf("codex = %+v", cx)
	}
}

// Fewer than five finished turns: no number, the count instead.
func TestBoardTooFewTurns(t *testing.T) {
	q, f, d := newTestQueue(t)
	now := time.Now().Truncate(time.Millisecond)
	q.now = func() time.Time { return now }
	f.owned["s1"] = agents.AgentClaude
	boardSession(t, d, "s1", "claude", "/new", true)
	boundAt(t, d, "s1", event.KindTurnUser, now.Add(-time.Hour), "")
	boundAt(t, d, "s1", event.KindAgentStop, now.Add(-59*time.Minute), "")
	b, err := q.Board(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	s := b.Sessions[0]
	if s.Estimate != nil || s.FreeIn != nil || s.EstimateNote != "1 turn finished in this project so far; an estimate needs 5" {
		t.Fatalf("session = %+v", s)
	}
	if len(b.Done) != 1 || b.Done[0].EndedAt != now.Add(-59*time.Minute).UnixMilli() {
		t.Fatalf("done = %+v", b.Done)
	}
}

// A queued message typed in at a Stop: its own turn's Stop tells onDone, and
// the board's Done list marks that turn as queued.
func TestQueuedMessageDoneIsHeardAndMarked(t *testing.T) {
	q, f, d := newTestQueue(t)
	ctx := context.Background()
	var mu sync.Mutex
	var heard []string
	q.onDone = func(ev event.Event, text string) {
		mu.Lock()
		defer mu.Unlock()
		heard = append(heard, ev.SessionID+":"+text)
	}
	count := func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string(nil), heard...)
	}
	f.owned["s1"] = agents.AgentClaude
	boardSession(t, d, "s1", "claude", "/r", true)
	hook(t, q, d, "s1", event.KindTurnUser, nil, false)
	if _, err := q.Send(ctx, "s1", "queued one"); err != nil {
		t.Fatal(err)
	}
	hook(t, q, d, "s1", event.KindAgentStop, nil, false) // the first turn ends: not a queued one
	waitQueue(t, "the queued message", func() bool { return strings.Contains(f.got("s1"), "queued one") })
	// The text reaches the terminal a moment before the queue records it as
	// in flight; a loaded runner delivered the next hook in between.
	waitQueue(t, "the message in flight", func() bool {
		q.mu.Lock()
		defer q.mu.Unlock()
		_, ok := q.inflight["s1"]
		return ok
	})
	if h := count(); len(h) != 0 {
		t.Fatalf("heard %v for a turn no queued message started", h)
	}
	hook(t, q, d, "s1", event.KindTurnUser, map[string]any{"prompt": "queued one"}, false)
	hook(t, q, d, "s1", event.KindAgentStop, nil, false)
	if h := count(); len(h) != 1 || h[0] != "s1:queued one" {
		t.Fatalf("heard %v", h)
	}
	b, err := q.Board(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(b.Done) != 2 || !b.Done[0].Queued || b.Done[0].Prompt != "queued one" || b.Done[1].Queued {
		t.Fatalf("done = %+v", b.Done)
	}
}
