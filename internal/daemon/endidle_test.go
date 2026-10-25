package daemon

import (
	"context"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/store"
)

// idleFake is the queue's fake manager plus each session's start, its last
// input or output, and which sessions End was called on.
type idleFake struct {
	*fakeSessions
	mu      sync.Mutex
	started map[string]time.Time
	io      map[string]time.Time
	ended   []string
	// exits makes End take the session out of the manager, as its exit does.
	exits bool
}

func (f *idleFake) Get(id string) (*agents.Agent, bool) {
	a, ok := f.fakeSessions.Get(id)
	if !ok {
		return nil, false
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	a.StartedAt = f.started[id]
	if t, ok := f.io[id]; ok {
		a.TouchIO(t)
	}
	return a, true
}

func (f *idleFake) IsShell(id string) bool {
	a, ok := f.fakeSessions.Get(id)
	return ok && a.Kind == agents.KindShell
}

func (f *idleFake) End(id string) error {
	f.mu.Lock()
	f.ended = append(f.ended, id)
	exits := f.exits
	f.mu.Unlock()
	if exits {
		f.fakeSessions.mu.Lock()
		delete(f.owned, id)
		f.fakeSessions.mu.Unlock()
	}
	return nil
}

func (f *idleFake) endedOnes() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.ended)
}

// idleStand is an idle end over the fake manager, with a clock the test
// moves: t0 is when the daemon started and every session with it.
type idleStand struct {
	e   *endIdle
	q   *msgQueue
	f   *idleFake
	d   *Daemon
	t0  time.Time
	now time.Time
	win time.Duration
	// bg is backgroundWork's answer per session (agentwork.go), under f.mu.
	bg map[string]string
}

func newIdleStand(t *testing.T) *idleStand {
	t.Helper()
	q, fs, d := newTestQueue(t)
	s := &idleStand{q: q, d: d, t0: time.Now(), win: 12 * time.Hour}
	s.now = s.t0
	s.f = &idleFake{fakeSessions: fs, started: map[string]time.Time{}, io: map[string]time.Time{}}
	s.e = newEndIdle(d, q, newOpenTabs(""))
	s.e.sess = s.f
	s.e.now = func() time.Time { return s.now }
	s.e.since = s.t0
	s.e.window = func() time.Duration { return s.win }
	s.e.worker = func(string) bool { return false }
	// What runs under each agent, by session: nothing unless a test says.
	s.bg = map[string]string{}
	s.e.bg = func(a *agents.Agent) string {
		s.f.mu.Lock()
		defer s.f.mu.Unlock()
		return s.bg[a.SessionID]
	}
	return s
}

// add starts a session Caprock owns at t0, with a row in the database.
func (s *idleStand) add(t *testing.T, id, kind string) {
	t.Helper()
	set(s.f.fakeSessions, s.f.owned, id, kind)
	s.f.mu.Lock()
	s.f.started[id] = s.t0
	s.f.mu.Unlock()
	if err := store.UpsertSession(context.Background(), s.d.store.DB(), id, store.SessionPatch{Cwd: t.TempDir(), Agent: kind}); err != nil {
		t.Fatal(err)
	}
}

// at moves the clock to t0+d and looks at every session.
func (s *idleStand) at(d time.Duration) {
	s.now = s.t0.Add(d)
	s.e.sweep(context.Background())
}

// event records an event for id at t0+d, as an ingester does.
func (s *idleStand) event(t *testing.T, id string, kind event.Kind, d time.Duration) {
	t.Helper()
	ev := &event.Event{SessionID: id, Source: event.SourceHook, Kind: kind, Ts: s.t0.Add(d)}
	if _, err := store.InsertEvent(context.Background(), s.d.store.DB(), ev); err != nil {
		t.Fatal(err)
	}
	// The recorder moves the session's last event with every event.
	if err := store.UpsertSession(context.Background(), s.d.store.DB(), id, store.SessionPatch{LastEventAt: ev.Ts.UnixMilli()}); err != nil {
		t.Fatal(err)
	}
}

func (s *idleStand) wantEnded(t *testing.T, want ...string) {
	t.Helper()
	got := s.f.endedOnes()
	if want == nil {
		want = []string{}
	}
	if got == nil {
		got = []string{}
	}
	slices.Sort(got)
	want = slices.Sorted(slices.Values(want))
	if !slices.Equal(got, want) {
		t.Fatalf("ended %v, want %v", got, want)
	}
}

func TestEndIdleEndsASessionIdleForTheWindowAndMarksWhy(t *testing.T) {
	s := newIdleStand(t)
	s.add(t, "s1", agents.AgentClaude)
	s.event(t, "s1", event.KindAgentStop, time.Minute)
	s.at(12*time.Hour - time.Minute)
	s.wantEnded(t)
	s.at(12*time.Hour + 2*time.Minute)
	s.wantEnded(t, "s1")
	got, err := store.GetSession(context.Background(), s.d.store.DB(), "s1")
	if err != nil {
		t.Fatal(err)
	}
	if got.IdleEndedAt != s.now.UnixMilli() || got.IdleEndedAfter != (12*time.Hour).Milliseconds() {
		t.Fatalf("idle end not recorded: at %d after %d", got.IdleEndedAt, got.IdleEndedAfter)
	}
	// Asked once: a second look while it exits does not ask again.
	s.at(12*time.Hour + 3*time.Minute)
	s.wantEnded(t, "s1")
	// Continued, the mark goes.
	if err := store.MarkOwned(context.Background(), s.d.store.DB(), "s1", "", "claude --resume s1", 42); err != nil {
		t.Fatal(err)
	}
	if got, _ := store.GetSession(context.Background(), s.d.store.DB(), "s1"); got.IdleEndedAt != 0 || got.IdleEndedAfter != 0 {
		t.Fatalf("a continued session still reads as ended for idling: %+v", got)
	}
}

// An event, input or output resets the clock; so does a new process.
func TestEndIdleActivityResetsTheClock(t *testing.T) {
	s := newIdleStand(t)
	for _, id := range []string{"event", "typed", "fresh"} {
		s.add(t, id, agents.AgentClaude)
	}
	s.event(t, "event", event.KindTurnUser, 6*time.Hour)
	s.event(t, "event", event.KindAgentStop, 6*time.Hour+time.Minute)
	s.f.mu.Lock()
	s.f.io["typed"] = s.t0.Add(8 * time.Hour)
	s.f.started["fresh"] = s.t0.Add(10 * time.Hour) // continued at 10 h
	s.f.mu.Unlock()
	s.at(13 * time.Hour)
	s.wantEnded(t)
	s.at(18*time.Hour + 2*time.Minute)
	s.wantEnded(t, "event")
	s.at(22*time.Hour + time.Minute)
	s.wantEnded(t, "event", "fresh", "typed")
}

// Anything waiting on someone keeps a session: a permission prompt, a
// question, a queued message, a paused process.
func TestEndIdleKeepsASessionThatWaitsOnSomething(t *testing.T) {
	s := newIdleStand(t)
	for _, id := range []string{"perm", "question", "queued"} {
		s.add(t, id, agents.AgentClaude)
	}
	set(s.f.fakeSessions, s.f.prompt, "perm", true)
	if err := insertQuestion(s, "question"); err != nil {
		t.Fatal(err)
	}
	// Mid-turn, so the message waits in the queue rather than being typed.
	s.event(t, "queued", event.KindTurnUser, time.Minute)
	if _, err := s.q.Send(context.Background(), "queued", "and then this"); err != nil {
		t.Fatal(err)
	}
	s.at(13 * time.Hour)
	s.wantEnded(t)
	set(s.f.fakeSessions, s.f.prompt, "perm", false)
	s.at(13*time.Hour + time.Minute)
	s.wantEnded(t, "perm")
}

// insertQuestion records an AskUserQuestion prompt, the hooks' question.
func insertQuestion(s *idleStand, id string) error {
	ev := &event.Event{SessionID: id, Source: event.SourceHook, Kind: event.KindPermissionPrompt, Tool: "AskUserQuestion", Ts: s.t0.Add(2 * time.Minute)}
	_, err := store.InsertEvent(context.Background(), s.d.store.DB(), ev)
	return err
}

// A tab, a shell, the orchestrator's workers, a session Caprock did not
// start (rule 7) and the first minutes after a start are never ended; Never
// ends nothing.
func TestEndIdleLeavesAlone(t *testing.T) {
	t.Run("a tab", func(t *testing.T) {
		s := newIdleStand(t)
		s.add(t, "tabbed", agents.AgentClaude)
		s.add(t, "closed", agents.AgentCodex)
		if err := s.e.tabs.report("mac", []string{"tabbed", "closed"}); err != nil {
			t.Fatal(err)
		}
		if err := s.e.tabs.report("phone", nil); err != nil {
			t.Fatal(err)
		}
		s.at(13 * time.Hour)
		s.wantEnded(t)
		// Its tab closed: now it is ended.
		if err := s.e.tabs.report("mac", []string{"tabbed"}); err != nil {
			t.Fatal(err)
		}
		s.at(13*time.Hour + time.Minute)
		s.wantEnded(t, "closed")
	})
	t.Run("a shell, a worker, not ours", func(t *testing.T) {
		s := newIdleStand(t)
		s.add(t, "shell", agents.KindShell)
		s.add(t, "worker", agents.AgentClaude)
		s.e.worker = func(id string) bool { return id == "worker" }
		// "theirs" has a row and an old event but no process of ours.
		if err := store.UpsertSession(context.Background(), s.d.store.DB(), "theirs", store.SessionPatch{Cwd: t.TempDir()}); err != nil {
			t.Fatal(err)
		}
		s.event(t, "theirs", event.KindAgentStop, time.Minute)
		s.at(30 * time.Hour)
		s.wantEnded(t)
	})
	t.Run("never", func(t *testing.T) {
		s := newIdleStand(t)
		s.add(t, "s1", agents.AgentClaude)
		s.win = 0
		s.at(100 * time.Hour)
		s.wantEnded(t)
	})
	t.Run("just started", func(t *testing.T) {
		s := newIdleStand(t)
		s.add(t, "s1", agents.AgentClaude)
		s.e.since = s.t0.Add(13 * time.Hour)
		s.at(13*time.Hour + time.Minute)
		s.wantEnded(t)
		s.at(13*time.Hour + endIdleStartGrace + time.Minute)
		s.wantEnded(t, "s1")
	})
}

// After a restart the clock is the session's own history, not the daemon's
// start: a session idle since before the restart is ended at the first look
// past the start's grace, and one with an event since is not.
func TestEndIdleAfterARestartMeasuresFromTheLastActivity(t *testing.T) {
	s := newIdleStand(t)
	s.add(t, "old", agents.AgentClaude)
	s.add(t, "recent", agents.AgentClaude)
	s.event(t, "old", event.KindAgentStop, time.Minute)
	s.event(t, "recent", event.KindAgentStop, 11*time.Hour)
	// The tabs a dashboard reported before the restart are kept on disk.
	dir := t.TempDir()
	before := newOpenTabs(dir)
	if err := before.report("mac", []string{"kept"}); err != nil {
		t.Fatal(err)
	}
	// A new daemon at 12 h 30 min: a new idle end, nothing seen yet.
	s.e = newEndIdle(s.d, s.q, newOpenTabs(dir))
	s.e.sess = s.f
	s.e.now = func() time.Time { return s.now }
	s.e.window = func() time.Duration { return s.win }
	s.e.worker = func(string) bool { return false }
	s.e.since = s.t0.Add(12*time.Hour + 30*time.Minute)
	if !s.e.tabs.open()["kept"] {
		t.Fatal("the reported tabs did not survive the restart")
	}
	s.add(t, "kept", agents.AgentClaude)
	s.at(12*time.Hour + 30*time.Minute + endIdleStartGrace + time.Minute)
	s.wantEnded(t, "old")
}
