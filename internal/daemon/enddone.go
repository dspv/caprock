package daemon

import (
	"context"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/store"
)

// end_when_done (03-contracts.md § POST /v1/agents): a session started with
// it is ended, the way End ends it (asked first, killed after the grace),
// once its turn finishes with nothing waiting on anyone. Without it a
// scripted start — a prompt every half hour — leaves an interactive TUI
// idle at its prompt for good: Codex's never exits by itself, and on the
// owner's machine 27 of them (94 processes, about 2 GB) piled up in a day
// (2026-10-21).
//
// "The turn finished" is the signal the rest of Caprock already reads:
// Claude Code's main-thread Stop hook, not turned back into a running turn
// by the task runner's Stop-loop; Codex's `task_complete` in its rollout
// (codex.Ingester.OnTurnDone). Nothing waits when, after a settle pause, no
// permission prompt is pending, no question or new turn has started, no
// message is queued for the session and no subagent it started still works.
//
// Only a session Caprock started with the flag is ever ended (rule 7): the
// flag lives on the manager's own Agent, which exists for no other process.

// endSessions is what end_when_done needs from the agent manager.
type endSessions interface {
	Get(id string) (*agents.Agent, bool)
	IsShell(id string) bool
	PendingPermission(id string) (*agents.Permission, bool)
	End(id string) error
}

type endWhenDone struct {
	d    *Daemon
	q    *msgQueue
	sess endSessions
	// settle is the pause after the turn-end signal before the session is
	// read again: Claude Code runs the Stop hook before it draws its prompt,
	// and whatever comes next (a Stop-loop's continue, a queued message, a
	// subagent's wake-up) has this long to show.
	settle time.Duration
	now    func() time.Time

	mu sync.Mutex
	// ending marks a session already asked to end, so a second signal does
	// not ask again.
	ending map[string]bool
}

// endWhenDoneSettle is the pause before a finished turn's session is ended.
const endWhenDoneSettle = 1500 * time.Millisecond

func newEndWhenDone(d *Daemon, q *msgQueue) *endWhenDone {
	e := &endWhenDone{d: d, q: q, settle: endWhenDoneSettle, now: time.Now, ending: map[string]bool{}}
	if d.mgr != nil {
		e.sess = d.mgr
	}
	return e
}

// afterMain is told every main-thread hook event once it is recorded, beside
// the queue (hookd.Handler.AfterMain).
func (e *endWhenDone) afterMain(ev *event.Event, continued bool) {
	if ev.Kind != event.KindAgentStop || continued {
		return
	}
	if a, ok := e.flagged(ev.SessionID); ok && a.Kind != agents.AgentCodex {
		go e.check(ev.SessionID)
	}
}

// codexDone is codex.Ingester.OnTurnDone: a Codex thread finished a request.
// A request that finished before this process was started is not its turn.
func (e *endWhenDone) codexDone(id string, at time.Time) {
	a, ok := e.flagged(id)
	if !ok || a.Kind != agents.AgentCodex || at.Before(a.StartedAt.Add(-time.Minute)) {
		return
	}
	go e.check(id)
}

// reattached looks at the flagged Claude Code sessions a previous daemon
// left running (ADR-033): a turn that ended while no daemon listened sent its
// Stop to nobody, and the stored events still say so.
func (e *endWhenDone) reattached(back []*agents.Agent) {
	for _, a := range back {
		if a.EndWhenDone && a.Kind != agents.AgentCodex && a.Kind != agents.KindShell {
			go e.check(a.SessionID)
		}
	}
}

// flagged is an owned, running session started with end_when_done.
func (e *endWhenDone) flagged(id string) (*agents.Agent, bool) {
	if e == nil || e.sess == nil {
		return nil, false
	}
	a, ok := e.sess.Get(id)
	if !ok || e.sess.IsShell(id) || !a.EndWhenDone {
		return nil, false
	}
	return a, true
}

// check ends the session after the settle pause if it is still flagged and
// nothing waits. It holds the queue's lock for the session, so a queued
// message is either typed in before it looks or not at all.
func (e *endWhenDone) check(id string) {
	time.Sleep(e.settle)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	unlock := e.q.lock(id)
	defer unlock()
	a, ok := e.flagged(id)
	if !ok {
		e.mu.Lock()
		delete(e.ending, id)
		e.mu.Unlock()
		return
	}
	if why, err := e.waitingOn(ctx, a); err != nil || why != "" {
		if err != nil {
			e.d.log.Warn("end_when_done: could not read the session", "component", "agents", "session_id", id, "err", err)
		} else {
			e.d.log.Info("end_when_done: the turn ended but the session is not done; left running", "component", "agents", "session_id", id, "waiting", why)
		}
		return
	}
	e.mu.Lock()
	if e.ending[id] {
		e.mu.Unlock()
		return
	}
	e.ending[id] = true
	e.mu.Unlock()
	if err := e.sess.End(id); err != nil {
		e.d.log.Warn("end_when_done: could not end the session", "component", "agents", "session_id", id, "err", err)
		e.mu.Lock()
		delete(e.ending, id)
		e.mu.Unlock()
		return
	}
	e.d.releaseFromWindowStop(id)
	e.d.log.Info("end_when_done: the turn finished; ended the session", "component", "agents", "session_id", id, "agent", a.Kind)
}

// waitingOn says what keeps a flagged session from being done, "" when
// nothing does.
func (e *endWhenDone) waitingOn(ctx context.Context, a *agents.Agent) (string, error) {
	if _, ok := e.sess.PendingPermission(a.SessionID); ok {
		return "permission", nil
	}
	db := e.d.store.DB()
	if msgs, err := store.ListQueued(ctx, db, a.SessionID); err != nil {
		return "", err
	} else if len(msgs) > 0 {
		return "queued", nil
	}
	if a.Kind == agents.AgentCodex {
		// Codex wrote task_complete, which it writes only once the request
		// is over: an approval it asks for comes before it.
		return "", nil
	}
	// Claude Code: the newest turn event its hooks recorded must be the
	// main thread's Stop. A session with none yet has not had its turn.
	evs, err := store.LastEventsFiltered(ctx, db, a.SessionID, queueTurnScan, store.EventFilter{MainOnly: true, Kinds: turnKinds})
	if err != nil {
		return "", err
	}
	if !lastHookIsStop(evs) {
		return "turn", nil
	}
	w, err := e.q.waiting(ctx, a)
	if err != nil || w != "" {
		return w, err
	}
	n, err := store.LiveSubagents(ctx, db, a.SessionID, e.now().Add(-store.LiveSubagentWindow).UnixMilli())
	if err != nil {
		return "", err
	}
	if n > 0 {
		return "subagents", nil
	}
	return "", nil
}

// lastHookIsStop reports whether the newest hook-recorded event (events
// oldest first) is a Stop.
func lastHookIsStop(evs []event.Event) bool {
	for i := len(evs) - 1; i >= 0; i-- {
		if evs[i].Source == event.SourceHook {
			return evs[i].Kind == event.KindAgentStop
		}
	}
	return false
}

// afterMain is hookd.Handler.AfterMain: the message queue, then
// end_when_done, which reads what the queue decided.
func (d *Daemon) afterMain(ev *event.Event, continued bool) {
	d.queue.afterMain(ev, continued)
	d.endDone.afterMain(ev, continued)
}
