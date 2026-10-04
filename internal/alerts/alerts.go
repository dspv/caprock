// Package alerts decides when the owner's phone hears about a session: at once
// when it shows a permission dialog, and a minute after it finishes a turn
// with nothing following. Pure rules over the event stream, with no clock or
// network of its own; the daemon feeds it and sends what it returns (ADR-036).
package alerts

import (
	"time"

	"github.com/dspv/caprock/internal/event"
)

// Kind is what an alert says about a session.
type Kind string

const (
	// KindApproval: the session is showing a permission dialog.
	KindApproval Kind = "approval"
	// KindFinished: the session ended a turn and nothing followed for a minute.
	KindFinished Kind = "finished"
)

// Defaults, chosen so that someone at the keyboard is never paged and someone
// away from it hears once.
const (
	// FinishedAfter is how long a Stop must stand before it is "finished": an
	// agent pausing between turns, or an owner replying at once, pages nobody.
	FinishedAfter = time.Minute
	// Cooldown is the quietest a session may be between two alerts of one kind.
	// A run of permission dialogs a few seconds apart is one interruption, and
	// whoever answered the first is already looking.
	Cooldown = 3 * time.Minute
	// HourlyCap bounds every alert together, whatever the sessions do.
	HourlyCap = 20
	// freshFor is how old an event may be and still page anyone. A transcript
	// read from the start after a restart replays every Stop it holds.
	freshFor = 2 * time.Minute
)

// Alert is one message to send.
type Alert struct {
	Kind      Kind
	SessionID string
	// Question says the dialog is AskUserQuestion's: waiting for an answer
	// rather than an approval.
	Question bool
	// LastThisHour says this alert used the hour's final slot, so the message
	// can say the rest are held back rather than leaving a silence to explain.
	LastThisHour bool
}

type session struct {
	waitingSince time.Time // a permission dialog is open since then; zero if none
	stoppedAt    time.Time // a Stop is pending as "finished"; zero if none
	lastSent     map[Kind]time.Time
}

// Rules holds what the alerts depend on: which sessions are waiting or
// stopped, and what was sent when. Not safe for concurrent use.
type Rules struct {
	// Enabled says whether a kind is switched on right now. A switched-off
	// kind is still tracked, so turning it on later starts from the truth.
	Enabled func(Kind) bool

	sessions map[string]*session
	sent     []time.Time
}

// New returns rules with nothing pending.
func New(enabled func(Kind) bool) *Rules {
	return &Rules{Enabled: enabled, sessions: map[string]*session{}}
}

func (r *Rules) state(id string) *session {
	s := r.sessions[id]
	if s == nil {
		s = &session{lastSent: map[Kind]time.Time{}}
		r.sessions[id] = s
	}
	return s
}

// Observe takes one stored event and returns the alerts it causes now: an
// approval alert for a permission dialog, at most one per dialog.
func (r *Rules) Observe(ev event.Event, now time.Time) []Alert {
	if ev.SessionID == "" || now.Sub(ev.Ts) > freshFor {
		return nil
	}
	if ev.Kind == event.KindPermissionPrompt {
		// A subagent's dialog stops the session as surely as its own.
		s := r.state(ev.SessionID)
		s.stoppedAt = time.Time{}
		if !s.waitingSince.IsZero() {
			return nil // one message per wait
		}
		s.waitingSince = ev.Ts
		out := r.emit(KindApproval, ev.SessionID, now)
		for i := range out {
			out[i].Question = ev.Tool == "AskUserQuestion"
		}
		return out
	}
	if ev.Subagent() {
		return nil
	}
	s, ok := r.sessions[ev.SessionID]
	if ev.Kind == event.KindAgentStop {
		s = r.state(ev.SessionID)
		s.waitingSince = time.Time{}
		s.stoppedAt = ev.Ts
		return nil
	}
	if !ok {
		return nil
	}
	// Anything the session does after a dialog answers it, and anything after
	// a Stop means somebody is there. Events stamped earlier are the
	// transcript catching up on what came before, and change nothing.
	if !s.waitingSince.IsZero() && ev.Ts.After(s.waitingSince) {
		s.waitingSince = time.Time{}
	}
	if !s.stoppedAt.IsZero() && ev.Ts.After(s.stoppedAt) {
		s.stoppedAt = time.Time{}
	}
	return nil
}

// Due returns the finished alerts whose minute has passed, and forgets
// sessions with nothing left to decide.
func (r *Rules) Due(now time.Time) []Alert {
	var out []Alert
	for id, s := range r.sessions {
		if !s.stoppedAt.IsZero() && now.Sub(s.stoppedAt) >= FinishedAfter {
			s.stoppedAt = time.Time{}
			out = append(out, r.emit(KindFinished, id, now)...)
		}
		if s.waitingSince.IsZero() && s.stoppedAt.IsZero() && r.quiet(s, now) {
			delete(r.sessions, id)
		}
	}
	return out
}

func (r *Rules) quiet(s *session, now time.Time) bool {
	for _, at := range s.lastSent {
		if now.Sub(at) < Cooldown {
			return false
		}
	}
	return true
}

// emit applies the switch, the per-session cooldown and the hourly cap.
func (r *Rules) emit(k Kind, id string, now time.Time) []Alert {
	if r.Enabled != nil && !r.Enabled(k) {
		return nil
	}
	s := r.state(id)
	if at, ok := s.lastSent[k]; ok && now.Sub(at) < Cooldown {
		return nil
	}
	kept := r.sent[:0]
	for _, at := range r.sent {
		if now.Sub(at) < time.Hour {
			kept = append(kept, at)
		}
	}
	r.sent = kept
	if len(r.sent) >= HourlyCap {
		return nil
	}
	r.sent = append(r.sent, now)
	s.lastSent[k] = now
	return []Alert{{Kind: k, SessionID: id, LastThisHour: len(r.sent) == HourlyCap}}
}
