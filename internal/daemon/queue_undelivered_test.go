package daemon

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/api"
	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/store"
)

// ADR-053, amendment of 2026-10-27: a message waiting in the queue is not
// lost when its session ends.

func texts(ms []store.QueuedMessage) string {
	out := make([]string, len(ms))
	for i, m := range ms {
		out[i] = m.Text
	}
	return strings.Join(out, ",")
}

func gone(f *fakeSessions, id string) {
	f.mu.Lock()
	delete(f.owned, id)
	f.mu.Unlock()
}

// A SessionEnd hook alone changes nothing (Claude Code sends one on /clear
// and on Escape); the process ending keeps the queue, in order, as not
// delivered — and a restart under the same id keeps it waiting.
func TestQueueKeptWhenTheProcessEnds(t *testing.T) {
	q, f, d := newTestQueue(t)
	ctx := context.Background()
	set(f, f.owned, "s1", agents.AgentClaude)
	hook(t, q, d, "s1", event.KindTurnUser, nil, false)
	for _, m := range []string{"one", "two"} {
		if res, err := q.Send(ctx, "s1", m); err != nil || res.Queued == nil {
			t.Fatalf("queue %q: %+v %v", m, res, err)
		}
	}

	hook(t, q, d, "s1", event.KindSessionEnd, map[string]any{"reason": "clear"}, false)
	time.Sleep(20 * time.Millisecond)
	if got := texts(queued(t, d, "s1")); got != "one,two" {
		t.Fatalf("a SessionEnd hook touched the queue: %q", got)
	}

	// A restart in another mode (ADR-054) is not the end of the queue.
	set(f, f.restarting, "s1", true)
	q.ended("s1")
	if got := texts(queued(t, d, "s1")); got != "one,two" {
		t.Fatalf("a restart ended the queue: %q", got)
	}
	set(f, f.restarting, "s1", false)

	gone(f, "s1")
	q.ended("s1")
	if l := queued(t, d, "s1"); len(l) != 0 {
		t.Fatalf("still waiting after the process ended: %+v", l)
	}
	v, err := q.View(ctx, "s1")
	if err != nil {
		t.Fatal(err)
	}
	if got := texts(v.Undelivered); got != "one,two" {
		t.Fatalf("undelivered = %q, want one,two", got)
	}
	if v.Undelivered[0].UndeliveredAt == 0 || len(v.Messages) != 0 {
		t.Fatalf("view: %+v", v)
	}
	// Nothing to type into: the start-up sweep and a Stop leave them be.
	q.startup(ctx)
	if got := f.got("s1"); got != "" {
		t.Fatalf("typed into an ended session: %q", got)
	}
	// Delete takes one away.
	v, err = q.Cancel(ctx, "s1", v.Undelivered[0].ID)
	if err != nil || texts(v.Undelivered) != "two" {
		t.Fatalf("delete: %+v %v", v, err)
	}
}

// The waiting rows of a session that ended while no daemon ran are kept as
// not delivered on start.
func TestQueueStartupKeepsAGoneSessionsQueue(t *testing.T) {
	q, _, d := newTestQueue(t)
	ctx := context.Background()
	if _, err := store.AddQueued(ctx, d.store.DB(), "old", "left over", time.Now()); err != nil {
		t.Fatal(err)
	}
	q.startup(ctx)
	und, err := store.ListUndelivered(ctx, d.store.DB(), "old")
	if err != nil || texts(und) != "left over" {
		t.Fatalf("undelivered after start: %+v %v", und, err)
	}
}

// A /clear gives the same process a new session id: the queue moves there
// and carries on, the oldest typed in once the new session's SessionStart
// has settled, the next one at the end of that turn.
func TestQueueFollowsClearToTheSuccessor(t *testing.T) {
	q, f, d := newTestQueue(t)
	ctx := context.Background()
	set(f, f.owned, "s1", agents.AgentClaude)
	hook(t, q, d, "s1", event.KindTurnUser, nil, false)
	for _, m := range []string{"a", "b"} {
		if _, err := q.Send(ctx, "s1", m); err != nil {
			t.Fatal(err)
		}
	}
	// As Claude Code does on /clear: SessionEnd for the old id, then a
	// SessionStart for the new one in the same process; the recorder's
	// OnClear then hands the queue over.
	hook(t, q, d, "s1", event.KindSessionEnd, map[string]any{"reason": "clear"}, false)
	set(f, f.owned, "s2", agents.AgentClaude)
	hook(t, q, d, "s2", event.KindAgentSpawn, map[string]any{"source": "clear"}, false)
	q.follow("s2", "s1")

	waitQueue(t, "the first message typed into the successor", func() bool { return strings.HasPrefix(f.got("s2"), "a") })
	if got := texts(queued(t, d, "s2")); got != "b" {
		t.Fatalf("successor's queue = %q, want b", got)
	}
	if l := queued(t, d, "s1"); len(l) != 0 {
		t.Fatalf("left behind on the old id: %+v", l)
	}
	hook(t, q, d, "s2", event.KindTurnUser, nil, false)
	hook(t, q, d, "s2", event.KindAgentStop, nil, false)
	waitQueue(t, "the second message", func() bool { return strings.Contains(f.got("s2"), "b") })
	if got := f.got("s1"); got != "" {
		t.Fatalf("typed into the replaced id: %q", got)
	}
}

// A compaction that names a new session mid-turn moves the queue, but types
// nothing until that turn ends.
func TestQueueFollowsACompactionWithoutTypingMidTurn(t *testing.T) {
	q, f, d := newTestQueue(t)
	ctx := context.Background()
	set(f, f.owned, "s1", agents.AgentClaude)
	hook(t, q, d, "s1", event.KindTurnUser, nil, false)
	if _, err := q.Send(ctx, "s1", "after"); err != nil {
		t.Fatal(err)
	}
	set(f, f.owned, "s2", agents.AgentClaude)
	hook(t, q, d, "s2", event.KindAgentSpawn, map[string]any{"source": "compact"}, false)
	q.follow("s2", "s1")
	time.Sleep(30 * time.Millisecond)
	if got := f.got("s2"); got != "" {
		t.Fatalf("typed mid-turn after a compaction: %q", got)
	}
	if got := texts(queued(t, d, "s2")); got != "after" {
		t.Fatalf("queue = %q", got)
	}
	hook(t, q, d, "s2", event.KindAgentStop, nil, false)
	waitQueue(t, "delivery at the end of the turn", func() bool { return strings.HasPrefix(f.got("s2"), "after") })
}

// Send to a new session: the undelivered messages wait in the new session's
// queue and go in through it — the first once it has started, the rest one
// per turn, in order. A resume under the ended session's own id does the
// same. Only the picked ones move.
func TestQueueResendDeliversInTheNewSession(t *testing.T) {
	q, f, d := newTestQueue(t)
	ctx := context.Background()
	set(f, f.owned, "s1", agents.AgentClaude)
	hook(t, q, d, "s1", event.KindTurnUser, nil, false)
	for _, m := range []string{"x", "y", "z"} {
		if _, err := q.Send(ctx, "s1", m); err != nil {
			t.Fatal(err)
		}
	}
	gone(f, "s1")
	q.ended("s1")
	und, _ := store.ListUndelivered(ctx, d.store.DB(), "s1")
	if len(und) != 3 {
		t.Fatalf("undelivered: %+v", und)
	}

	// A fresh session: started, not yet at its prompt.
	set(f, f.owned, "n1", agents.AgentClaude)
	v, err := q.Resend(ctx, "s1", "n1", []int64{und[0].ID, und[1].ID}, true)
	if err != nil {
		t.Fatal(err)
	}
	if texts(v.Messages) != "x,y" || v.SessionID != "n1" || v.Waiting != api.WaitingStart {
		t.Fatalf("resend view: %+v", v)
	}
	time.Sleep(20 * time.Millisecond)
	if got := f.got("n1"); got != "" {
		t.Fatalf("typed before the new session started: %q", got)
	}
	if left, _ := store.ListUndelivered(ctx, d.store.DB(), "s1"); texts(left) != "z" {
		t.Fatalf("left undelivered: %q", texts(left))
	}
	hook(t, q, d, "n1", event.KindAgentSpawn, map[string]any{"source": "startup"}, false)
	waitQueue(t, "x typed in at the new session's prompt", func() bool { return f.got("n1") == "x\r" })
	hook(t, q, d, "n1", event.KindTurnUser, nil, false)
	hook(t, q, d, "n1", event.KindAgentStop, nil, false)
	waitQueue(t, "y one turn later", func() bool { return f.got("n1") == "x\ry\r" })

	// The rest by resuming the ended conversation under its own id.
	set(f, f.owned, "s1", agents.AgentClaude)
	if _, err := q.Resend(ctx, "s1", "s1", nil, true); err != nil {
		t.Fatal(err)
	}
	hook(t, q, d, "s1", event.KindAgentSpawn, map[string]any{"source": "resume"}, false)
	waitQueue(t, "z typed into the resumed session", func() bool { return strings.HasSuffix(f.got("s1"), "z\r") })
	if left, _ := store.ListUndelivered(ctx, d.store.DB(), "s1"); len(left) != 0 {
		t.Fatalf("still undelivered: %+v", left)
	}
	if _, err := q.Resend(ctx, "s1", "s1", nil, false); err == nil {
		t.Fatal("resend with nothing undelivered should fail")
	}
}

// A session started for them that never sends a hook gets them typed in at
// once, in order: no turn end would ever come.
func TestQueueResendWithoutHooks(t *testing.T) {
	q, f, d := newTestQueue(t)
	ctx := context.Background()
	q.noHooks = 20 * time.Millisecond
	for _, m := range []string{"p", "q"} {
		if _, err := store.AddQueued(ctx, d.store.DB(), "s1", m, time.Now()); err != nil {
			t.Fatal(err)
		}
	}
	q.ended("s1")
	set(f, f.owned, "n1", agents.AgentClaude)
	if _, err := q.Resend(ctx, "s1", "n1", nil, true); err != nil {
		t.Fatal(err)
	}
	waitQueue(t, "both typed in", func() bool { return f.got("n1") == "p\rq\r" })
	if l := queued(t, d, "n1"); len(l) != 0 {
		t.Fatalf("still waiting: %+v", l)
	}
}

// Undelivered messages are kept 7 days, then the product deletes them.
func TestQueuePrunesUndeliveredAfterAWeek(t *testing.T) {
	q, f, d := newTestQueue(t)
	ctx := context.Background()
	t0 := time.Date(2026, 10, 27, 12, 0, 0, 0, time.UTC)
	q.now = func() time.Time { return t0 }
	set(f, f.owned, "s1", agents.AgentClaude)
	hook(t, q, d, "s1", event.KindTurnUser, nil, false)
	if _, err := q.Send(ctx, "s1", "kept a while"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.AddQueued(ctx, d.store.DB(), "live", "still waiting", t0.Add(-30*24*time.Hour)); err != nil {
		t.Fatal(err)
	}
	gone(f, "s1")
	q.ended("s1")

	q.now = func() time.Time { return t0.Add(6 * 24 * time.Hour) }
	q.prune(ctx)
	if und, _ := store.ListUndelivered(ctx, d.store.DB(), "s1"); len(und) != 1 {
		t.Fatalf("pruned before 7 days: %+v", und)
	}
	q.now = func() time.Time { return t0.Add(7*24*time.Hour + time.Minute) }
	q.prune(ctx)
	if und, _ := store.ListUndelivered(ctx, d.store.DB(), "s1"); len(und) != 0 {
		t.Fatalf("kept past 7 days: %+v", und)
	}
	// A message still waiting is never pruned, however old.
	if l := queued(t, d, "live"); len(l) != 1 {
		t.Fatalf("a waiting message was pruned: %+v", l)
	}
}
