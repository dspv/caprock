package daemon

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/api"
	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/keepawake"
	"github.com/dspv/caprock/internal/narrate"
	"github.com/dspv/caprock/internal/store"
)

// Settings → When a limit is reached (ADR-090).
//
//   - "ask" (the default): nothing happens by itself. The session carries
//     limit_hit and the app shows the choices; a button calls continue-on.
//   - "auto": a session Caprock started that hits its limit is continued on
//     the first of limit_fallbacks that is available, once per limit, and
//     the app is told (a "continued" frame with auto true) so it can offer
//     Undo — continue-on back to the move's From.
//   - "wait": nothing happens by itself either. Claude Code has already
//     stopped the turn; there is nothing to pause, so the plan-window stop
//     (Premium, internal/cap/window.go, which pauses at a share below 100%)
//     is not what this is.
//
// With limit_return_after_reset on, a session moved automatically goes back
// to the sign-in it left once that sign-in's window has reset — when it is
// not in the middle of a turn. The return list is kept in limit_returns
// (migration 0081) and read back on the first tick after a start, so a
// daemon restart keeps it; one due more than returnStale before that start
// is dropped as a stale plan, and the session stays where it is.

// limitPoll is how often the watcher looks. A limit stops a session for
// hours; a few seconds more before it moves is nothing.
const limitPoll = 15 * time.Second

// returnGrace is how long after a reset the return waits: the window has
// to have reopened by the plan's clock, not only by ours.
const returnGrace = time.Minute

// returnStale is how long past due a stored return may be when a starting
// daemon reads it back: older than this, the plan is stale and is dropped.
const returnStale = time.Hour

// limitWatch is the watcher's state.
type limitWatch struct {
	mu sync.Mutex
	// handled is each session's limit (LimitHit.At) already acted on, so
	// one limit moves a session once.
	handled map[string]int64
	// returns are the automatic moves to undo after the reset, by the
	// session now carrying the work.
	returns map[string]limitReturn
	// restored is set once the stored returns were read back.
	restored bool
	// moved is each session's limit (LimitHit.At) an automatic move took
	// elsewhere: the work goes on there, so the session is not resumed.
	moved map[string]int64
	// resumed is each session's limit already resumed after its reset
	// (autoResume), so one limit gets one "continue".
	resumed map[string]int64
}

type limitReturn struct {
	to string // the target to go back to: the move's From
	at int64  // unix ms after which to go back
}

func (w *limitWatch) init() {
	if w.handled == nil {
		w.handled, w.returns = map[string]int64{}, map[string]limitReturn{}
		w.moved, w.resumed = map[string]int64{}, map[string]int64{}
	}
}

// forget drops a pending return for id — the user moved it by hand, it went
// back, or its session is gone — here and in the database.
func (d *Daemon) forgetReturn(ctx context.Context, id string) {
	w := &d.limits
	w.mu.Lock()
	_, had := w.returns[id]
	delete(w.returns, id)
	w.mu.Unlock()
	if !had {
		return
	}
	if err := store.DeleteLimitReturn(ctx, d.store.DB(), id); err != nil {
		d.log.Warn("could not forget a return after the reset", "component", "continue-on", "session", id, "err", err)
	}
}

// restoreReturns reads the stored returns back once per daemon, dropping
// the stale ones and the ones whose session has ended.
func (d *Daemon) restoreReturns(ctx context.Context, now time.Time) {
	w := &d.limits
	w.mu.Lock()
	w.init()
	done := w.restored
	w.restored = true
	w.mu.Unlock()
	if done {
		return
	}
	list, err := store.RestoreLimitReturns(ctx, d.store.DB(), now.Add(-returnStale).UnixMilli())
	if err != nil {
		d.log.Warn("could not read the returns after the reset", "component", "continue-on", "err", err)
		return
	}
	w.mu.Lock()
	for _, r := range list {
		if _, set := w.returns[r.SessionID]; !set {
			w.returns[r.SessionID] = limitReturn{to: r.To, at: r.At}
		}
	}
	w.mu.Unlock()
	if len(list) > 0 {
		d.log.Info("returns after the reset read back", "component", "continue-on", "count", len(list))
	}
}

func (d *Daemon) limitLoop(ctx context.Context) {
	t := time.NewTicker(limitPoll)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			d.limitTick(ctx, time.Now())
		}
	}
}

// limitTick acts once on what the sessions say now.
func (d *Daemon) limitTick(ctx context.Context, now time.Time) {
	if d.mgr == nil {
		return
	}
	d.restoreReturns(ctx, now)
	cfg := d.config()
	auto := config.NormalizeLimitAction(cfg.LimitAction) == config.LimitAuto
	if auto || cfg.LimitAutoResumeOn() {
		list, err := store.OwnedAtLimit(ctx, d.store.DB())
		if err != nil {
			d.log.Warn("could not read sessions at a limit", "component", "continue-on", "err", err)
		}
		if auto {
			for _, s := range list {
				d.autoContinue(ctx, cfg, s)
			}
		}
		if cfg.LimitAutoResumeOn() {
			for _, s := range list {
				d.autoResume(ctx, s, now)
			}
		}
	}
	d.dueReturns(ctx, now)
}

// autoContinue moves one session at its limit to the first fallback that
// takes it.
func (d *Daemon) autoContinue(ctx context.Context, cfg config.Config, s store.Session) {
	if s.LimitHit == nil {
		return
	}
	if _, held := d.mgr.Get(s.SessionID); !held {
		return
	}
	w := &d.limits
	w.mu.Lock()
	w.init()
	if w.handled[s.SessionID] == s.LimitHit.At {
		w.mu.Unlock()
		return
	}
	w.handled[s.SessionID] = s.LimitHit.At
	w.mu.Unlock()
	from := subscriptionName(s.Subscription)
	for _, target := range cfg.LimitFallbacks {
		if target == from {
			continue
		}
		res, err := d.continueOn(ctx, s.SessionID, target, true)
		var refusal api.ContinueRefusal
		if errors.As(err, &refusal) {
			d.log.Info("limit fallback not available", "component", "continue-on", "session", s.SessionID, "target", target, "why", refusal.Msg)
			continue
		}
		if err != nil {
			d.log.Warn("could not continue a session at its limit", "component", "continue-on", "session", s.SessionID, "target", target, "err", err)
			return
		}
		if cfg.LimitReturnAfterReset && s.LimitHit.ResetsAt > 0 {
			res.ReturnAt = s.LimitHit.ResetsAt + returnGrace.Milliseconds()
			w.mu.Lock()
			w.returns[res.SessionID] = limitReturn{to: from, at: res.ReturnAt}
			w.mu.Unlock()
			if err := store.SetLimitReturn(ctx, d.store.DB(), store.LimitReturn{SessionID: res.SessionID, To: from, At: res.ReturnAt}); err != nil {
				d.log.Warn("could not keep the return after the reset", "component", "continue-on", "session", res.SessionID, "err", err)
			}
		}
		w.mu.Lock()
		w.moved[s.SessionID] = s.LimitHit.At
		w.mu.Unlock()
		d.publishContinued(res)
		_, _ = d.RecordHandled(ctx, store.HandledItem{Kind: store.HandledLimitSwitch, SessionID: res.SessionID,
			Text: "Moved to " + d.targetLabel(res.Target) + " at the usage limit", Reason: res.Note,
			Undo: &store.HandledUndo{Kind: store.HandledUndoContinueOn, SessionID: res.SessionID, Target: res.From}})
		return
	}
	d.log.Info("a session hit its limit and no fallback could take it", "component", "continue-on", "session", s.SessionID)
}

// dueReturns takes each moved session whose original window has reset back
// to it, unless it is mid-turn (then the next tick tries again).
func (d *Daemon) dueReturns(ctx context.Context, now time.Time) {
	w := &d.limits
	w.mu.Lock()
	w.init()
	due := map[string]limitReturn{}
	for id, r := range w.returns {
		if now.UnixMilli() >= r.at {
			due[id] = r
		}
	}
	w.mu.Unlock()
	for id, r := range due {
		if _, held := d.mgr.Get(id); !held {
			d.forgetReturn(ctx, id)
			continue
		}
		if d.sessionBusy(ctx, id, now) {
			continue
		}
		d.forgetReturn(ctx, id)
		res, err := d.continueOn(ctx, id, r.to, true)
		if err != nil {
			d.log.Warn("could not take a session back after the reset", "component", "continue-on", "session", id, "target", r.to, "err", err)
			continue
		}
		res.Note = "The window reset: " + res.Note
		d.publishContinued(res)
		_, _ = d.RecordHandled(ctx, store.HandledItem{Kind: store.HandledLimitReturn, SessionID: res.SessionID,
			Text: "Moved back to " + d.targetLabel(res.Target) + " after the window reset", Reason: res.Note})
	}
}

// sessionBusy reports whether a session is in the middle of a turn, as the
// sleep keeper reads it (keepawake.go).
func (d *Daemon) sessionBusy(ctx context.Context, id string, now time.Time) bool {
	db := d.store.DB()
	last, err := store.LastEvents(ctx, db, id, 20)
	if err != nil {
		return true
	}
	live, err := store.LiveSubagents(ctx, db, id, now.Add(-store.LiveSubagentWindow).UnixMilli())
	if err != nil {
		return true
	}
	act := narrate.Summarize(last, narrate.Options{Now: now, IdleAfter: keepawake.Silence, LiveSubagents: live})
	return busy(act, last)
}

// resumeStale is how long after its reset a stopped session is still
// resumed: a stop older than that is one the person has seen and left.
const resumeStale = 6 * time.Hour

// resumeText is what an automatic resume types, as Jarvis's Continue does.
const resumeText = "continue"

// autoResume carries on a session Caprock started that a usage limit
// stopped, once that limit's window has reset (ADR-096): "continue" goes
// through its message queue, as Jarvis's Continue sends it — typed at once
// when the session is at its prompt, queued otherwise. Once per limit; not
// for a session an automatic move took elsewhere, one someone already set
// going again since the limit, one with a message already waiting, or one
// whose reset is not known or long past.
func (d *Daemon) autoResume(ctx context.Context, s store.Session, now time.Time) {
	hit := s.LimitHit
	if hit == nil || hit.ResetsAt <= 0 || !s.Owned || d.queue == nil {
		return
	}
	due := hit.ResetsAt + returnGrace.Milliseconds()
	if now.UnixMilli() < due || now.UnixMilli() > hit.ResetsAt+resumeStale.Milliseconds() {
		return
	}
	if _, held := d.mgr.Get(s.SessionID); !held {
		return
	}
	w := &d.limits
	w.mu.Lock()
	w.init()
	if w.moved[s.SessionID] == hit.At || w.resumed[s.SessionID] == hit.At {
		w.mu.Unlock()
		return
	}
	w.mu.Unlock()
	if d.sessionBusy(ctx, s.SessionID, now) {
		return
	}
	if again, err := promptedSince(ctx, d.store.DB(), s.SessionID, hit.At); err != nil || again {
		if again {
			w.mu.Lock()
			w.resumed[s.SessionID] = hit.At
			w.mu.Unlock()
		}
		return
	}
	if v, err := d.queue.View(ctx, s.SessionID); err != nil || len(v.Messages) > 0 {
		return
	}
	w.mu.Lock()
	w.resumed[s.SessionID] = hit.At
	w.mu.Unlock()
	res, err := d.queue.Send(ctx, s.SessionID, resumeText)
	if err != nil {
		d.log.Warn("could not resume a session after the limit reset", "component", "continue-on", "session", s.SessionID, "err", err)
		return
	}
	d.log.Info("resumed a session after the limit reset", "component", "continue-on", "session", s.SessionID, "queued", res.Queued != nil)
	reason := "The usage limit that stopped it has reset; Caprock typed \"continue\"."
	if res.Queued != nil {
		reason = "The usage limit that stopped it has reset; \"continue\" goes in when the session is at its prompt."
	}
	_, _ = d.RecordHandled(ctx, store.HandledItem{Kind: store.HandledLimitResume, SessionID: s.SessionID,
		Text: "Continued after the usage limit reset", Reason: reason})
}

// promptedSince reports whether the session's main thread got a prompt
// after at (unix ms): someone set it going again since the limit.
func promptedSince(ctx context.Context, db store.Querier, id string, at int64) (bool, error) {
	last, err := store.LastEvents(ctx, db, id, 50)
	if err != nil {
		return false, err
	}
	for _, e := range last {
		if e.Kind == event.KindTurnUser && !e.Subagent() && e.Ts.UnixMilli() > at {
			return true, nil
		}
	}
	return false, nil
}
