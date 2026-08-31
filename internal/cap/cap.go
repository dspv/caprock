// A daily spend cap that pauses the sessions Caprock started.
//
// This is the first paid feature, and the argument for it is one sentence: a
// runaway loop stops at $40 instead of finishing at $400. Everything else this
// product does is observation — you look and you learn something. A cap is the
// first thing that acts while you are asleep.
//
// # What it may and may not touch
//
// Only sessions Caprock spawned. [Rule 7] predates this feature and survives
// it: a session you started in your own terminal is watched and never signalled,
// however much it is costing. That is not a limitation to be worked around
// later — it is the reason anyone lets this daemon near their machine.
//
// # Pause, not kill
//
// A paused session is SIGSTOP'd and can be resumed with everything intact: the
// conversation, the working directory, the context it has built up. Killing
// would be simpler and would throw away work that has already been paid for,
// which is a strange thing for a tool that exists to stop waste.
//
// # What happens when the licence lapses
//
// The cap keeps working; the threshold becomes read-only. Switching off
// someone's overspend protection the moment their card expires is the worst
// possible timing for it — they are least able to notice and most likely to be
// hurt. Selling protection and then removing it on a technicality is not what
// was sold. See ADR-022 for why the key is a convenience rather than a lock.
//
// [Rule 7]: ../../CLAUDE.md
package cap

import (
	"context"
	"log/slog"
	"sync"
	"time"
)

// Signaller pauses one owned session. Implemented by agents.Manager; an
// interface so this package can be tested without a PTY, and so it cannot
// reach anything else on the manager.
type Signaller interface {
	// PauseOwned pauses the session if Caprock owns it, and reports whether it
	// did. A session it does not own must be refused here rather than filtered
	// by the caller — the rule belongs next to the thing that enforces it.
	PauseOwned(sessionID string) (bool, error)
	// OwnedRunning lists the sessions Caprock started that are still running.
	OwnedRunning() []string
}

// Settings is the cap's own configuration, read fresh on every check so a
// change takes effect without a restart.
type Settings struct {
	// LimitUSD is the day's ceiling. Zero or negative means the cap is off,
	// which is the default: a threshold nobody chose is a threshold that will
	// eventually stop work for a reason its owner cannot explain.
	LimitUSD float64
}

// Spend reports what today has cost so far, in the daemon's local day.
type Spend func(ctx context.Context) (float64, error)

// Notify is called once when the cap fires. Delivery is somebody else's
// problem — this package decides *that* it happened, never how it is announced.
type Notify func(ctx context.Context, ev Event)

// Event is what happened, for the notifier and for the log.
type Event struct {
	At       time.Time
	LimitUSD float64
	SpendUSD float64
	// Paused is the sessions that were actually paused, which is not the same
	// as the sessions that were running: one may exit between the decision and
	// the signal.
	Paused []string
}

// Guard watches the day's spend and pauses owned sessions when it crosses the
// limit.
type Guard struct {
	Settings func() Settings
	Spend    Spend
	Sig      Signaller
	Notify   Notify
	Log      *slog.Logger
	// Now is injected so the day boundary is testable. A cap that resets at
	// the wrong hour is a cap that fires at breakfast.
	Now func() time.Time

	mu sync.Mutex
	// firedOn is the day (YYYY-MM-DD, local) the cap last fired.
	//
	// Without it, every priced turn after the threshold would pause again:
	// a session resumed by hand would be re-paused within seconds, which reads
	// as the product fighting its owner. Firing once per day is the whole
	// behaviour — after that the person is informed and it is their call.
	firedOn string
}

// dayKey is the local calendar day, which is what "a daily cap" means to the
// person setting one. UTC would fire mid-afternoon for half the world.
func (g *Guard) dayKey(t time.Time) string { return t.Format("2006-01-02") }

// Check evaluates the cap and pauses if it has been crossed. It is called after
// every priced turn, so it must be cheap and must not block the write path.
//
// Returns true when it fired.
func (g *Guard) Check(ctx context.Context) bool {
	set := g.Settings()
	if set.LimitUSD <= 0 {
		return false
	}

	now := g.Now()
	day := g.dayKey(now)

	g.mu.Lock()
	already := g.firedOn == day
	g.mu.Unlock()
	if already {
		return false
	}

	spend, err := g.Spend(ctx)
	if err != nil {
		// A cap that cannot read the spend must not guess. Failing open is the
		// right direction: a missed pause costs money, a spurious one stops
		// work that was fine — and the second is the one people never forgive.
		g.log().Warn("cap: cannot read today's spend; not pausing", "component", "cap", "err", err)
		return false
	}
	if spend < set.LimitUSD {
		return false
	}

	// Claim the day before signalling, so two concurrent turns crossing the
	// threshold together cannot both pause.
	g.mu.Lock()
	if g.firedOn == day {
		g.mu.Unlock()
		return false
	}
	g.firedOn = day
	g.mu.Unlock()

	ev := Event{At: now, LimitUSD: set.LimitUSD, SpendUSD: spend}
	for _, id := range g.Sig.OwnedRunning() {
		ok, err := g.Sig.PauseOwned(id)
		if err != nil {
			// One session failing to pause must not prevent the others.
			g.log().Warn("cap: could not pause a session", "component", "cap", "session_id", id, "err", err)
			continue
		}
		if ok {
			ev.Paused = append(ev.Paused, id)
		}
	}

	g.log().Info("cap: day limit reached; paused Caprock's own sessions",
		"component", "cap", "limit_usd", set.LimitUSD, "spend_usd", spend, "paused", len(ev.Paused))

	if g.Notify != nil {
		g.Notify(ctx, ev)
	}
	return true
}

// FiredOn reports the day the cap last fired, for the API to say so.
func (g *Guard) FiredOn() string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.firedOn
}

// Reset clears the fired state. Used when the limit changes: raising it after a
// pause should let work continue, not leave the cap latched until midnight.
func (g *Guard) Reset() {
	g.mu.Lock()
	g.firedOn = ""
	g.mu.Unlock()
}

func (g *Guard) log() *slog.Logger {
	if g.Log != nil {
		return g.Log
	}
	return slog.Default()
}

// Suggest proposes a limit from the user's own history rather than an invented
// round number.
//
// A blank field asking for a dollar figure gets one of two answers: a number so
// high it never fires, or one so low it fires on a normal Tuesday. Both teach
// the person that the feature is useless. Their own median day is the only
// figure that is neither, and it is a fact rather than a guess (rule 6).
//
// The multiplier is deliberate slack: a cap set at the median fires half the
// time by definition. 2x the median day is "today is unusual", which is what
// someone actually wants to be told.
func Suggest(medianDayUSD float64) float64 {
	if medianDayUSD <= 0 {
		return 0
	}
	v := medianDayUSD * 2
	// Rounded to something a person would type. $147.83 as a suggested ceiling
	// reads as a computation, not a decision.
	switch {
	case v < 10:
		return roundTo(v, 1)
	case v < 100:
		return roundTo(v, 5)
	default:
		return roundTo(v, 10)
	}
}

func roundTo(v, step float64) float64 {
	if step <= 0 {
		return v
	}
	return float64(int((v+step/2)/step)) * step
}
