package cap

// The plan-window stop (Premium; owner decision, 2026-10-08).
//
// The daily cap is priced in list-price dollars, which a Pro or Max
// subscriber never pays, so it guards against a loss most users do not have.
// What they run out of is the plan window: Anthropic's five-hour and weekly
// allowances, which Claude Code reports on its status line. This guard pauses
// the Claude Code sessions Caprock started when either window crosses a share
// the user picked, and resumes them once that window has reset.
//
// # Why a share below 100%
//
// At 100% Claude Code stops by itself — the turn ends on a rate-limit error
// and the session sits idle, its work abandoned mid-task, until someone types
// "continue" after the reset. A pause at 90% stops the unattended sessions
// mid-turn with their state intact, leaves the rest of the window for the
// person at the keyboard, and lets the work carry on after the reset with
// nobody there. SIGCONT continues a turn; nothing continues a turn that has
// already failed.
//
// # The rules, each tested
//
//   - Only sessions Caprock started, and only Claude Code ones. The window is
//     Claude's; a Codex or Gemini session Caprock started does not spend it and
//     is not paused for it. Rule 7 is enforced by PauseOwned, as for the cap.
//   - Never on stale figures. A sample older than FreshFor, or one whose reset
//     clock is already past or implausibly far ahead, does not pause anything.
//     Usage inside a window only rises, so an old 92% is probably still true —
//     but "probably" is not a reason to stop someone's work, and a reset that
//     happened since would make it false.
//   - Once per window. When a stop fires it latches the windows that crossed
//     (by name and reset time). A session resumed by hand is not paused again
//     in the same window, and a session started after the notice is not either:
//     the person has been told, and from there it is their call — the daily
//     cap's own rule. A stop that found nothing to pause does not latch, so a
//     session Caprock starts later in the window is still covered.
//   - Resumed after the reset, by the same guard that paused it. The promise
//     made by the pause is kept even if the setting is turned off or the
//     licence lapses in between. A session the user resumed, paused or ended
//     by hand in the meantime is released (Release) and left alone.
//   - Unlicensed: no pause at all. The free 90% alert on Now is untouched and
//     is not this package's business.
//   - The state survives a restart. Sessions in pty-hosts outlive the daemon
//     (ADR-033), and a session left SIGSTOPped because the daemon that meant
//     to resume it was upgraded meanwhile would be the worst failure here.

import (
	"context"
	"log/slog"
	"sort"
	"sync"
	"time"
)

// FreshFor is how old a plan-window sample may be and still pause anything.
//
// Claude Code sends one per assistant message while a session runs, so a
// running owned session — the only thing this guard can pause — keeps the
// figures minutes old at most. Ten minutes leaves room for a long tool call.
const FreshFor = 10 * time.Minute

// ResumeGrace is how long after a window's reset the paused sessions resume.
// A clock a few seconds apart from Anthropic's would otherwise resume a turn
// into the last moments of the old window.
const ResumeGrace = time.Minute

// maxResetAhead bounds a believable reset clock: the weekly window is the
// longest, and a figure claiming more than this is a stale or corrupt sample.
// The dashboard's alert uses the same bound (ui/src/lib/attention.ts).
const maxResetAhead = 8 * 24 * time.Hour

// DefaultWindowPct is the share used when the user has never chosen one: the
// same 90% at which the free alert speaks.
const DefaultWindowPct = 90

// MinWindowPct and MaxWindowPct bound the setting. Below half the stop would
// fire on an ordinary morning; at 100% Claude Code has already stopped itself.
const (
	MinWindowPct = 50
	MaxWindowPct = 99
)

// The plan windows by the names the status line feed stores them under.
const (
	WindowFiveHour = "five_hour"
	WindowSevenDay = "seven_day"
)

// WindowSignaller is the slice of the session manager this guard may use.
type WindowSignaller interface {
	// PauseOwned and ResumeOwned act only on a session Caprock owns, and
	// report whether they did; an id the manager does not own is refused there.
	PauseOwned(sessionID string) (bool, error)
	ResumeOwned(sessionID string) (bool, error)
	// OwnedRunningKind lists the running sessions Caprock started with the
	// named agent ("claude").
	OwnedRunningKind(kind string) []string
}

// Window is one plan window as Claude Code last reported it.
type Window struct {
	Name       string
	UsedPct    float64
	ResetsAt   time.Time
	ObservedAt time.Time
}

// WindowSettings is read fresh on every check.
type WindowSettings struct {
	// Pct is the share of a window that pauses; zero or less is off.
	Pct int
	// Licensed is whether Premium is active. Without it nothing is paused.
	Licensed bool
}

// Fresh reports whether a sample may be acted on at now, and if not, why.
func Fresh(w Window, now time.Time) (bool, string) {
	switch {
	case w.ObservedAt.IsZero():
		return false, "no figures yet"
	case now.Sub(w.ObservedAt) > FreshFor:
		return false, "figures older than ten minutes"
	case !w.ResetsAt.After(now):
		return false, "the window has reset since"
	case w.ResetsAt.Sub(now) > maxResetAhead:
		return false, "a reset time too far ahead to believe"
	}
	return true, ""
}

// PausedSession is one session the guard paused and will resume.
type PausedSession struct {
	SessionID string `json:"session_id"`
	// ResumeAt is the reset (unix seconds) after which it is resumed: the
	// latest reset among the windows over the share when it was paused.
	ResumeAt int64 `json:"resume_at"`
	// Window is the window that resets last, the one the notice names.
	Window   string `json:"window"`
	PausedAt int64  `json:"paused_at"` // unix ms
}

// latch is one window instance the stop has fired for.
type latch struct {
	Window   string `json:"window"`
	ResetsAt int64  `json:"resets_at"`
}

// WindowState is what the guard persists between daemon runs.
type WindowState struct {
	Paused  []PausedSession `json:"paused,omitempty"`
	Latched []latch         `json:"latched,omitempty"`
	// Last is the most recent stop, for the notice.
	Last *WindowEvent `json:"last,omitempty"`
}

// WindowEvent is a stop or a resume, for the notifier and the dashboard.
type WindowEvent struct {
	// Kind is "paused" or "resumed".
	Kind string `json:"kind"`
	At   int64  `json:"at"` // unix ms
	// Window and UsedPct name the window that resets last among those over
	// the share; ResumeAt is its reset (unix seconds).
	Window   string  `json:"window,omitempty"`
	UsedPct  float64 `json:"used_percentage,omitempty"`
	Pct      int     `json:"threshold_pct,omitempty"`
	ResumeAt int64   `json:"resume_at,omitempty"`
	// Sessions are the ones actually paused or resumed.
	Sessions []string `json:"sessions"`
}

// WindowGuard pauses owned Claude Code sessions when a plan window crosses
// the chosen share, and resumes them after its reset.
type WindowGuard struct {
	Settings func() WindowSettings
	Windows  func(ctx context.Context) ([]Window, error)
	Sig      WindowSignaller
	// Notify announces a stop or a resume. Optional.
	Notify func(ctx context.Context, ev WindowEvent)
	// Save persists the state after every change. Optional.
	Save func(ctx context.Context, st WindowState) error
	Log  *slog.Logger
	Now  func() time.Time

	// mu serialises every check, resume and release, signals included: they
	// are few and fast, and two of them interleaving is how a session gets
	// paused after it was resumed.
	mu    sync.Mutex
	state WindowState
}

// Load restores the state a previous run saved.
func (g *WindowGuard) Load(st WindowState) {
	g.mu.Lock()
	g.state = st
	g.mu.Unlock()
}

// State returns a copy of the current state.
func (g *WindowGuard) State() WindowState {
	g.mu.Lock()
	defer g.mu.Unlock()
	out := WindowState{
		Paused:  append([]PausedSession(nil), g.state.Paused...),
		Latched: append([]latch(nil), g.state.Latched...),
	}
	if g.state.Last != nil {
		ev := *g.state.Last
		ev.Sessions = append([]string(nil), ev.Sessions...)
		out.Last = &ev
	}
	return out
}

// Check pauses the owned Claude Code sessions if a fresh window has crossed
// the share and has not fired already. Returns whether it paused anything.
func (g *WindowGuard) Check(ctx context.Context) bool {
	set := g.Settings()
	if !set.Licensed || set.Pct <= 0 {
		return false
	}
	ws, err := g.Windows(ctx)
	if err != nil {
		// Fails open, like the cap: a spurious pause is the one nobody forgives.
		g.log().Warn("window stop: cannot read the plan windows; not pausing", "component", "cap", "err", err)
		return false
	}
	now := g.Now()

	ev, ok := g.fire(ctx, set, ws, now)
	if ok && g.Notify != nil {
		g.Notify(ctx, ev)
	}
	return ok
}

// fire is Check under the lock; the notifier is called after it is released.
func (g *WindowGuard) fire(ctx context.Context, set WindowSettings, ws []Window, now time.Time) (WindowEvent, bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.pruneLatches(now)

	var over []Window
	fresh := false
	for _, w := range ws {
		if float64(set.Pct) > w.UsedPct {
			continue
		}
		if ok, why := Fresh(w, now); !ok {
			g.log().Debug("window stop: over the share but not acting on it", "component", "cap", "window", w.Name, "used", w.UsedPct, "why", why)
			continue
		}
		over = append(over, w)
		if !g.latched(w) {
			fresh = true
		}
	}
	if !fresh {
		return WindowEvent{}, false
	}

	// The window that resets last decides when work may continue: a weekly
	// window over the share keeps sessions paused past the five-hour reset.
	last := over[0]
	for _, w := range over[1:] {
		if w.ResetsAt.After(last.ResetsAt) {
			last = w
		}
	}

	ids := g.Sig.OwnedRunningKind("claude")
	sort.Strings(ids)
	ev := WindowEvent{Kind: "paused", At: now.UnixMilli(), Window: last.Name, UsedPct: last.UsedPct, Pct: set.Pct, ResumeAt: last.ResetsAt.Unix()}
	for _, id := range ids {
		ok, err := g.Sig.PauseOwned(id)
		if err != nil {
			g.log().Warn("window stop: could not pause a session", "component", "cap", "session_id", id, "err", err)
			continue
		}
		if !ok {
			continue
		}
		ev.Sessions = append(ev.Sessions, id)
		g.track(id, last, now)
	}
	// Nothing was running: nothing was announced, so nothing is latched. A
	// session Caprock starts later in this window is still covered.
	if len(ev.Sessions) == 0 {
		return WindowEvent{}, false
	}
	for _, w := range over {
		if !g.latched(w) {
			g.state.Latched = append(g.state.Latched, latch{Window: w.Name, ResetsAt: w.ResetsAt.Unix()})
		}
	}
	g.state.Last = &ev
	g.log().Info("window stop: plan window over the share; paused Caprock's own Claude Code sessions",
		"component", "cap", "window", last.Name, "used", last.UsedPct, "pct", set.Pct, "paused", len(ev.Sessions), "resume_at", last.ResetsAt)
	g.save(ctx)
	return ev, true
}

// track records a paused session, or moves its resume later when it was
// already paused for a window that resets sooner.
func (g *WindowGuard) track(id string, w Window, now time.Time) {
	for i, p := range g.state.Paused {
		if p.SessionID == id {
			if w.ResetsAt.Unix() > p.ResumeAt {
				g.state.Paused[i].ResumeAt = w.ResetsAt.Unix()
				g.state.Paused[i].Window = w.Name
			}
			return
		}
	}
	g.state.Paused = append(g.state.Paused, PausedSession{SessionID: id, ResumeAt: w.ResetsAt.Unix(), Window: w.Name, PausedAt: now.UnixMilli()})
}

// ResumeDue resumes every session whose window has reset, and returns them.
// A session that has ended in the meantime is dropped quietly.
func (g *WindowGuard) ResumeDue(ctx context.Context) []string {
	resumed, ev := g.resumeDue(ctx, g.Now())
	if ev != nil && g.Notify != nil {
		g.Notify(ctx, *ev)
	}
	return resumed
}

func (g *WindowGuard) resumeDue(ctx context.Context, now time.Time) ([]string, *WindowEvent) {
	g.mu.Lock()
	defer g.mu.Unlock()
	var keep []PausedSession
	var resumed []string
	changed := false
	for _, p := range g.state.Paused {
		if now.Before(time.Unix(p.ResumeAt, 0).Add(ResumeGrace)) {
			keep = append(keep, p)
			continue
		}
		changed = true
		ok, err := g.Sig.ResumeOwned(p.SessionID)
		if err != nil {
			g.log().Warn("window stop: could not resume a session", "component", "cap", "session_id", p.SessionID, "err", err)
			continue
		}
		if ok {
			resumed = append(resumed, p.SessionID)
		}
	}
	if !changed {
		return nil, nil
	}
	g.state.Paused = keep
	g.pruneLatches(now)
	var out *WindowEvent
	if len(resumed) > 0 {
		ev := WindowEvent{Kind: "resumed", At: now.UnixMilli(), Sessions: resumed}
		g.state.Last = &ev
		out = &ev
		g.log().Info("window stop: window reset; resumed Caprock's own sessions", "component", "cap", "resumed", len(resumed))
	}
	g.save(ctx)
	return resumed, out
}

// Release forgets a session the user signalled by hand — resumed, paused
// again or ended — so the guard does not resume it later behind their back.
func (g *WindowGuard) Release(ctx context.Context, sessionID string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	for i, p := range g.state.Paused {
		if p.SessionID == sessionID {
			g.state.Paused = append(g.state.Paused[:i], g.state.Paused[i+1:]...)
			g.save(ctx)
			return
		}
	}
}

// ResetLatch lets the stop fire again in the current window. Used when the
// share changes: a share lowered after a stop is a new instruction.
// Sessions already paused stay on their resume schedule.
func (g *WindowGuard) ResetLatch(ctx context.Context) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if len(g.state.Latched) == 0 {
		return
	}
	g.state.Latched = nil
	g.save(ctx)
}

// Run resumes what is due and re-checks the windows every interval until ctx
// ends. The check also runs whenever a new sample arrives; this loop is what
// resumes sessions after a reset, when no session is left to send one.
func (g *WindowGuard) Run(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	g.ResumeDue(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			g.ResumeDue(ctx)
			g.Check(ctx)
		}
	}
}

// latchSlack is how far apart two reset clocks may be and still name the same
// window instance. The next instance of a window resets hours later, never
// minutes, so this cannot merge two windows; it keeps a reset time reported a
// few seconds differently from un-latching the stop.
const latchSlack = 30 * 60 // seconds

func (g *WindowGuard) latched(w Window) bool {
	for _, l := range g.state.Latched {
		d := l.ResetsAt - w.ResetsAt.Unix()
		if l.Window == w.Name && d < latchSlack && d > -latchSlack {
			return true
		}
	}
	return false
}

// pruneLatches drops latches for windows that have already reset.
func (g *WindowGuard) pruneLatches(now time.Time) {
	keep := g.state.Latched[:0]
	for _, l := range g.state.Latched {
		if time.Unix(l.ResetsAt, 0).After(now) {
			keep = append(keep, l)
		}
	}
	g.state.Latched = keep
}

func (g *WindowGuard) save(ctx context.Context) {
	if g.Save == nil {
		return
	}
	if err := g.Save(ctx, g.state); err != nil {
		g.log().Warn("window stop: could not save its state", "component", "cap", "err", err)
	}
}

func (g *WindowGuard) log() *slog.Logger {
	if g.Log != nil {
		return g.Log
	}
	return slog.Default()
}
