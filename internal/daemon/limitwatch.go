package daemon

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/api"
	"github.com/dspv/caprock/internal/config"
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
// not in the middle of a turn. The return list is held in memory: a daemon
// restart forgets it, and the session stays where it is.

// limitPoll is how often the watcher looks. A limit stops a session for
// hours; a few seconds more before it moves is nothing.
const limitPoll = 15 * time.Second

// returnGrace is how long after a reset the return waits: the window has
// to have reopened by the plan's clock, not only by ours.
const returnGrace = time.Minute

// limitWatch is the watcher's state.
type limitWatch struct {
	mu sync.Mutex
	// handled is each session's limit (LimitHit.At) already acted on, so
	// one limit moves a session once.
	handled map[string]int64
	// returns are the automatic moves to undo after the reset, by the
	// session now carrying the work.
	returns map[string]limitReturn
}

type limitReturn struct {
	to string // the target to go back to: the move's From
	at int64  // unix ms after which to go back
}

func (w *limitWatch) init() {
	if w.handled == nil {
		w.handled, w.returns = map[string]int64{}, map[string]limitReturn{}
	}
}

// forget drops a pending return for id: the user moved it by hand.
func (w *limitWatch) forget(id string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	delete(w.returns, id)
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
	cfg := d.config()
	if config.NormalizeLimitAction(cfg.LimitAction) == config.LimitAuto {
		list, err := store.OwnedAtLimit(ctx, d.store.DB())
		if err != nil {
			d.log.Warn("could not read sessions at a limit", "component", "continue-on", "err", err)
		}
		for _, s := range list {
			d.autoContinue(ctx, cfg, s)
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
		}
		d.publishContinued(res)
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
			w.forget(id)
			continue
		}
		if d.sessionBusy(ctx, id, now) {
			continue
		}
		w.forget(id)
		res, err := d.continueOn(ctx, id, r.to, true)
		if err != nil {
			d.log.Warn("could not take a session back after the reset", "component", "continue-on", "session", id, "target", r.to, "err", err)
			continue
		}
		res.Note = "The window reset: " + res.Note
		d.publishContinued(res)
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
