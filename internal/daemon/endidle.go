package daemon

import (
	"context"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/api"
	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/store"
)

// Ending idle sessions (03-contracts.md § Ending idle sessions; owner,
// 2026-10-21). An agent session Caprock started with no tab — a chat from
// Chats, Now or the phone, a Telegram /new or forward, a continue, a relay,
// a fork, an attempt, a row under Running, no tab — never ends by itself:
// its TUI waits at its prompt for good. On the owner's Mac 27 idle Codex
// sessions held about 2 GB. Once one has been idle for the window chosen in
// Settings (end_idle_after, 12 h by default), Caprock ends its process the
// way End does (asked first, so the transcript is written, killed after the
// grace). The conversation stays listed, marked as ended for idling, and is
// continued with --resume like any ended one.
//
// Idle means, for the whole window: nothing typed into it, nothing drawn by
// it and no event from it (hooks, transcript, Codex rollout); and now no
// permission prompt or question open, no message queued, no subagent at
// work, and the process not paused. A turn that runs draws: Claude Code's
// and Codex's working line animates every second. So a turn the hooks still
// call running with nothing drawn for the window is one Esc interrupted,
// which writes no Stop, and is not kept alive by that.
//
// The last activity is the newest of the process's start, the session's
// last event in the database and the input and output this daemon saw.
// Output replayed by a pty-host to a daemon that reattached does not count
// (agents.Agent.LastIO), so a restart does not start the clock again; and
// nothing is ended in the first minutes after a start, so a session that is
// in fact working has drawn again by the first look.
//
// Never ended: a session Caprock did not start (rule 7: the manager holds
// no other), a shell, a session any dashboard has a tab for (opentabs.go),
// and the orchestrator and its workers while it runs.

const (
	// endIdleTick is how often the sessions are looked at.
	endIdleTick = time.Minute
	// endIdleStartGrace is how long after this daemon starts nothing is
	// ended: reattached sessions draw again, dashboards report their tabs.
	endIdleStartGrace = 3 * time.Minute
)

// idleSessions is what the idle end needs from the agent manager.
type idleSessions interface {
	OwnedRunning() []string
	Get(id string) (*agents.Agent, bool)
	IsShell(id string) bool
	PendingPermission(id string) (*agents.Permission, bool)
	End(id string) error
}

type endIdle struct {
	d    *Daemon
	q    *msgQueue
	sess idleSessions
	tabs *openTabs
	now  func() time.Time
	// window is the idle window now chosen; 0 is never.
	window func() time.Duration
	// worker reports the orchestrator or one of its workers.
	worker func(id string) bool
	// since is when this daemon began; nothing ends before since plus
	// endIdleStartGrace.
	since time.Time

	mu sync.Mutex
	// ending marks a session already asked to end.
	ending map[string]bool
}

func newEndIdle(d *Daemon, q *msgQueue, tabs *openTabs) *endIdle {
	e := &endIdle{d: d, q: q, tabs: tabs, now: time.Now, since: time.Now(), ending: map[string]bool{},
		window: func() time.Duration { return config.EndIdleWindow(d.config().EndIdleAfter) },
		worker: func(id string) bool {
			_, o := d.hiveState()
			return o != nil && o.AgentIDForSession(id) != ""
		},
	}
	if d.mgr != nil {
		e.sess = d.mgr
	}
	return e
}

func (e *endIdle) run(ctx context.Context) {
	t := time.NewTicker(endIdleTick)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			e.sweep(ctx)
		}
	}
}

// sweep ends every session that has been idle for the window.
func (e *endIdle) sweep(ctx context.Context) {
	if e == nil || e.sess == nil {
		return
	}
	win := e.window()
	now := e.now()
	if win <= 0 || now.Sub(e.since) < endIdleStartGrace {
		return
	}
	open := e.tabs.open()
	running := e.sess.OwnedRunning()
	e.forgetGone(running)
	for _, id := range running {
		if ctx.Err() != nil {
			return
		}
		if open[id] || e.sess.IsShell(id) || (e.worker != nil && e.worker(id)) {
			continue
		}
		e.check(ctx, id, win, now)
	}
}

// forgetGone drops the marks of sessions no longer running.
func (e *endIdle) forgetGone(running []string) {
	live := make(map[string]bool, len(running))
	for _, id := range running {
		live[id] = true
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	for id := range e.ending {
		if !live[id] {
			delete(e.ending, id)
		}
	}
}

// check ends one session if it has been idle for win. It holds the queue's
// lock for the session, so a queued message is either typed in before it
// looks or not at all.
func (e *endIdle) check(ctx context.Context, id string, win time.Duration, now time.Time) {
	unlock := e.q.lock(id)
	defer unlock()
	e.mu.Lock()
	asked := e.ending[id]
	e.mu.Unlock()
	if asked {
		return
	}
	a, ok := e.sess.Get(id)
	if !ok || a.Kind == agents.KindShell {
		return
	}
	db := e.d.store.DB()
	last, err := e.lastActive(ctx, a)
	if err != nil {
		e.d.log.Warn("end idle: could not read the session", "component", "agents", "session_id", id, "err", err)
		return
	}
	if now.Sub(last) < win {
		return
	}
	if why, err := e.waitingOn(ctx, a, now); err != nil || why != "" {
		if err != nil {
			e.d.log.Warn("end idle: could not read the session", "component", "agents", "session_id", id, "err", err)
		}
		return
	}
	e.mu.Lock()
	e.ending[id] = true
	e.mu.Unlock()
	// Marked before the end is asked for, so the frame its exit sends
	// already says why.
	if err := store.MarkIdleEnded(ctx, db, id, now.UnixMilli(), win.Milliseconds()); err != nil {
		e.d.log.Warn("end idle: could not mark the session", "component", "agents", "session_id", id, "err", err)
	}
	if err := e.sess.End(id); err != nil {
		e.d.log.Warn("end idle: could not end the session", "component", "agents", "session_id", id, "err", err)
		_ = store.MarkIdleEnded(ctx, db, id, 0, 0)
		e.mu.Lock()
		delete(e.ending, id)
		e.mu.Unlock()
		return
	}
	e.d.releaseFromWindowStop(id)
	e.d.log.Info("end idle: ended a session idle with no tab", "component", "agents", "session_id", id, "agent", a.Kind,
		"idle_for", now.Sub(last).Round(time.Minute).String(), "window", win.String())
}

// lastActive is the newest of the process's start, the session's last event
// and the input and output this daemon saw.
func (e *endIdle) lastActive(ctx context.Context, a *agents.Agent) (time.Time, error) {
	last := a.StartedAt
	if t := a.LastIO(); t.After(last) {
		last = t
	}
	s, err := store.GetSession(ctx, e.d.store.DB(), a.SessionID)
	if err != nil {
		return time.Time{}, err
	}
	if t := time.UnixMilli(s.LastEventAt); s.LastEventAt > 0 && t.After(last) {
		last = t
	}
	return last, nil
}

// waitingOn says what keeps an idle session from being ended, "" when
// nothing does.
func (e *endIdle) waitingOn(ctx context.Context, a *agents.Agent, now time.Time) (string, error) {
	if a.Paused() {
		// Paused by the spend cap or the plan-window stop, maybe mid-turn:
		// theirs to resume.
		return "paused", nil
	}
	if _, ok := e.sess.PendingPermission(a.SessionID); ok {
		return "permission", nil
	}
	db := e.d.store.DB()
	if msgs, err := store.ListQueued(ctx, db, a.SessionID); err != nil {
		return "", err
	} else if len(msgs) > 0 {
		return "queued", nil
	}
	// A question (AskUserQuestion) is a prompt the hooks recorded; the
	// manager's PendingPermission is the other kind. A turn the hooks call
	// running is not reason enough: see the top of this file.
	switch w, err := e.q.waiting(ctx, a); {
	case err != nil:
		return "", err
	case w == api.WaitingPermission || w == api.WaitingQuestion:
		return w, nil
	}
	n, err := store.LiveSubagents(ctx, db, a.SessionID, now.Add(-store.LiveSubagentWindow).UnixMilli())
	if err != nil {
		return "", err
	}
	if n > 0 {
		return "subagents", nil
	}
	return "", nil
}
