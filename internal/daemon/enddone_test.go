package daemon

import (
	"context"
	"encoding/json"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/store"
)

// endFake is the queue's fake manager, plus which sessions were started with
// end_when_done and which End was called on.
type endFake struct {
	*fakeSessions
	mu      sync.Mutex
	flagged map[string]bool
	started time.Time
	ended   []string
}

func (e *endFake) Get(id string) (*agents.Agent, bool) {
	a, ok := e.fakeSessions.Get(id)
	if !ok {
		return nil, false
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	a.EndWhenDone = e.flagged[id]
	a.StartedAt = e.started
	return a, true
}

func (e *endFake) End(id string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.ended = append(e.ended, id)
	return nil
}

func (e *endFake) endedOnes() []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	return slices.Clone(e.ended)
}

func newTestEndDone(t *testing.T) (*endWhenDone, *msgQueue, *endFake, *Daemon) {
	t.Helper()
	q, f, d := newTestQueue(t)
	ef := &endFake{fakeSessions: f, flagged: map[string]bool{}, started: time.Now()}
	e := newEndWhenDone(d, q)
	e.sess = ef
	e.settle = time.Millisecond
	return e, q, ef, d
}

// endHook records a main-thread hook event and tells both listeners, as
// Daemon.afterMain does.
func endHook(t *testing.T, e *endWhenDone, q *msgQueue, d *Daemon, id, agentID string, kind event.Kind, payload map[string]any, continued bool) {
	t.Helper()
	evSeq++
	raw, _ := json.Marshal(payload)
	ev := &event.Event{SessionID: id, AgentID: agentID, Source: event.SourceHook, Kind: kind, Ts: time.Now().Add(time.Duration(evSeq) * time.Millisecond), Payload: raw}
	if _, err := store.InsertEvent(context.Background(), d.store.DB(), ev); err != nil {
		t.Fatal(err)
	}
	if agentID != "" {
		return // hookd tells AfterMain only the main thread's
	}
	q.afterMain(ev, continued)
	e.afterMain(ev, continued)
}

// aTurn is one whole turn of a Claude Code session, up to the hook before
// its Stop.
func aTurn(t *testing.T, e *endWhenDone, q *msgQueue, d *Daemon, id string) {
	t.Helper()
	endHook(t, e, q, d, id, "", event.KindAgentSpawn, map[string]any{"source": "startup"}, false)
	endHook(t, e, q, d, id, "", event.KindTurnUser, nil, false)
	endHook(t, e, q, d, id, "", event.KindToolPre, map[string]any{"tool_name": "Bash"}, false)
	endHook(t, e, q, d, id, "", event.KindToolPost, map[string]any{"tool_name": "Bash"}, false)
}

// stillRunning waits long enough for a check that would end the session to
// have done so, and fails if it did.
func stillRunning(t *testing.T, ef *endFake, why string) {
	t.Helper()
	time.Sleep(150 * time.Millisecond)
	if got := ef.endedOnes(); len(got) != 0 {
		t.Fatalf("%s: ended %v", why, got)
	}
}

func TestEndWhenDoneEndsAFlaggedSessionWhenItsTurnFinishes(t *testing.T) {
	e, q, ef, d := newTestEndDone(t)
	set(ef.fakeSessions, ef.owned, "s1", agents.AgentClaude)
	ef.flagged["s1"] = true
	aTurn(t, e, q, d, "s1")
	stillRunning(t, ef, "mid-turn")
	endHook(t, e, q, d, "s1", "", event.KindAgentStop, nil, false)
	waitQueue(t, "the session to be ended", func() bool { return len(ef.endedOnes()) == 1 })
	// A second Stop does not ask again.
	endHook(t, e, q, d, "s1", "", event.KindAgentStop, nil, false)
	time.Sleep(100 * time.Millisecond)
	if got := ef.endedOnes(); !slices.Equal(got, []string{"s1"}) {
		t.Fatalf("ended %v, want s1 once", got)
	}
}

// Rule 7, and the flag being opt-in: a session started without it, and one
// Caprock did not start at all, are never ended.
func TestEndWhenDoneLeavesOtherSessionsAlone(t *testing.T) {
	e, q, ef, d := newTestEndDone(t)
	set(ef.fakeSessions, ef.owned, "plain", agents.AgentClaude)
	for _, id := range []string{"plain", "not-ours"} {
		aTurn(t, e, q, d, id)
		endHook(t, e, q, d, id, "", event.KindAgentStop, nil, false)
	}
	e.codexDone("plain", time.Now())
	e.codexDone("not-ours", time.Now())
	stillRunning(t, ef, "unflagged and unowned sessions")
}

// A permission prompt waiting is not "done", nor is a question, a Stop the
// task runner turned into "keep going", a queued message or a subagent still
// at work.
func TestEndWhenDoneWaitsWhileSomethingWaits(t *testing.T) {
	t.Run("permission", func(t *testing.T) {
		e, q, ef, d := newTestEndDone(t)
		set(ef.fakeSessions, ef.owned, "s1", agents.AgentClaude)
		ef.flagged["s1"] = true
		aTurn(t, e, q, d, "s1")
		set(ef.fakeSessions, ef.prompt, "s1", true)
		endHook(t, e, q, d, "s1", "", event.KindAgentStop, nil, false)
		stillRunning(t, ef, "a permission prompt waiting")
		// Answered, the turn goes on and finishes: now it is done.
		set(ef.fakeSessions, ef.prompt, "s1", false)
		endHook(t, e, q, d, "s1", "", event.KindToolPost, map[string]any{"tool_name": "Bash"}, false)
		endHook(t, e, q, d, "s1", "", event.KindAgentStop, nil, false)
		waitQueue(t, "the session to be ended", func() bool { return len(ef.endedOnes()) == 1 })
	})
	t.Run("question after the stop", func(t *testing.T) {
		e, q, ef, d := newTestEndDone(t)
		e.settle = 100 * time.Millisecond
		set(ef.fakeSessions, ef.owned, "s1", agents.AgentClaude)
		ef.flagged["s1"] = true
		aTurn(t, e, q, d, "s1")
		endHook(t, e, q, d, "s1", "", event.KindAgentStop, nil, false)
		// Within the settle pause the session asks something.
		endHook(t, e, q, d, "s1", "", event.KindPermissionPrompt, map[string]any{"tool_name": "AskUserQuestion"}, false)
		stillRunning(t, ef, "a question asked after the Stop")
	})
	t.Run("stop-loop", func(t *testing.T) {
		e, q, ef, d := newTestEndDone(t)
		set(ef.fakeSessions, ef.owned, "s1", agents.AgentClaude)
		ef.flagged["s1"] = true
		aTurn(t, e, q, d, "s1")
		endHook(t, e, q, d, "s1", "", event.KindAgentStop, nil, true)
		stillRunning(t, ef, "a Stop the task runner continued")
	})
	t.Run("queued", func(t *testing.T) {
		e, q, ef, d := newTestEndDone(t)
		set(ef.fakeSessions, ef.owned, "s1", agents.AgentClaude)
		ef.flagged["s1"] = true
		aTurn(t, e, q, d, "s1")
		if _, err := q.Send(context.Background(), "s1", "and then this"); err != nil {
			t.Fatal(err)
		}
		endHook(t, e, q, d, "s1", "", event.KindAgentStop, nil, false)
		stillRunning(t, ef, "a queued message")
	})
	t.Run("subagent", func(t *testing.T) {
		e, q, ef, d := newTestEndDone(t)
		set(ef.fakeSessions, ef.owned, "s1", agents.AgentClaude)
		ef.flagged["s1"] = true
		aTurn(t, e, q, d, "s1")
		endHook(t, e, q, d, "s1", "agent-1", event.KindToolPre, map[string]any{"tool_name": "Read"}, false)
		endHook(t, e, q, d, "s1", "", event.KindAgentStop, nil, false)
		stillRunning(t, ef, "a subagent still working")
	})
}

func TestEndWhenDoneEndsAFlaggedCodexSessionOnTaskComplete(t *testing.T) {
	e, _, ef, _ := newTestEndDone(t)
	set(ef.fakeSessions, ef.owned, "cx", agents.AgentCodex)
	ef.flagged["cx"] = true
	// A request finished before this process started is not its turn.
	e.codexDone("cx", ef.started.Add(-time.Hour))
	stillRunning(t, ef, "an older request")
	e.codexDone("cx", time.Now())
	waitQueue(t, "the Codex session to be ended", func() bool { return len(ef.endedOnes()) == 1 })
}

// After a restart: a flagged session whose stored events end on a Stop is
// done; one that has not had its turn yet is not.
func TestEndWhenDoneLooksAtReattachedSessions(t *testing.T) {
	e, q, ef, d := newTestEndDone(t)
	for _, id := range []string{"done", "fresh"} {
		set(ef.fakeSessions, ef.owned, id, agents.AgentClaude)
		ef.flagged[id] = true
	}
	aTurn(t, e, q, d, "done")
	evSeq++
	stop := &event.Event{SessionID: "done", Source: event.SourceHook, Kind: event.KindAgentStop, Ts: time.Now().Add(time.Duration(evSeq) * time.Millisecond)}
	if _, err := store.InsertEvent(context.Background(), d.store.DB(), stop); err != nil {
		t.Fatal(err)
	}
	e.reattached([]*agents.Agent{
		{SessionID: "done", Kind: agents.AgentClaude, EndWhenDone: true},
		{SessionID: "fresh", Kind: agents.AgentClaude, EndWhenDone: true},
	})
	waitQueue(t, "the finished session to be ended", func() bool { return len(ef.endedOnes()) == 1 })
	time.Sleep(100 * time.Millisecond)
	if got := ef.endedOnes(); !slices.Equal(got, []string{"done"}) {
		t.Fatalf("ended %v, want only the one whose turn finished", got)
	}
}
