package daemon

import (
	"context"
	"strings"
	"time"

	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/api"
	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/rollup"
	"github.com/dspv/caprock/internal/store"
)

// Resume after an API error (ADR-105; Settings → After an API error).
//
// Claude Code retries a failed API call itself ("API error · retrying…
// attempt 2/10"); while it does, the turn runs and nothing here acts. Once
// its retries are spent it writes the error into the transcript as a
// synthetic assistant line and ends the turn. The tailer keeps that line on
// the session (migration 0095, ingest.APIErrorLine), with whether a
// "continue" may get past it: overloaded, a 5xx, a network failure or a
// timeout may; a usage limit (ADR-090's flow), a sign-in, billing, a
// request too long or any other 4xx may not.
//
// For a retryable one in a Claude Code session Caprock started (rule 7),
// sitting at its prompt with nothing queued, the watcher types "continue"
// through the message queue — the way the chat field types — a minute after
// the error, then five minutes after the next one, then fifteen: three
// tries for one incident. A real reply ends the incident ("recovered"); a
// fourth error after the third try is a give-up, and the alert that turn's
// failure raises says so. A message the user sent after the error, or a key
// typed into the session's terminal, hands the session back to the user:
// nothing more is typed for that error. Each try is the prompt event it
// becomes, marked via "auto_resume", so it stands in the session's history.

// viaAutoResume marks the prompt Caprock typed after an API error.
const viaAutoResume = "auto_resume"

// autoResumeText is what is typed.
const autoResumeText = "continue"

// resumeBackoff is the pause before each try, from the error it answers.
var resumeBackoff = []time.Duration{time.Minute, 5 * time.Minute, 15 * time.Minute}

// resumeMaxTries is how many times one incident is resumed.
var resumeMaxTries = len(resumeBackoff)

// resumeStep is what the watcher does about one session now.
type resumeStep int

const (
	// stepNone: nothing, and the error is not Caprock's to answer — not
	// retryable, the user took over, or it already gave up.
	stepNone resumeStep = iota
	// stepWait: the pause before the next try is not over.
	stepWait
	// stepAwait: a try went in for this error; its turn decides.
	stepAwait
	// stepResume: type "continue" now.
	stepResume
	// stepGiveUp: the tries ran out.
	stepGiveUp
	// stepStop: the user typed into the session; leave it to them.
	stepStop
)

// resumeFacts is what the decision reads about one session.
type resumeFacts struct {
	Err store.APIError
	Now time.Time
	// PromptAfterError: the user sent a message after the error.
	PromptAfterError bool
	// PromptAfterResume: the user sent a message after Caprock's last try,
	// so a later error is a new incident.
	PromptAfterResume bool
	// KeyAfterError: someone typed into the session's terminal after it.
	KeyAfterError bool
}

// decideResume is the watcher's rule, pure: the step, and the tries the
// incident has had before it.
func decideResume(f resumeFacts) (resumeStep, int) {
	e := f.Err
	if e.At <= 0 {
		return stepNone, 0
	}
	continuing := (e.Resume == store.ResumeResumed || e.Resume == store.ResumeGaveUp) && !f.PromptAfterResume
	tries := 0
	if continuing {
		tries = e.Tries
	}
	if !e.Retryable {
		return stepNone, tries
	}
	switch {
	case e.Resume == store.ResumeStopped && e.For == e.At:
		return stepNone, tries
	case e.Resume == store.ResumeGaveUp && continuing:
		return stepNone, tries
	case f.PromptAfterError:
		return stepNone, tries
	case f.KeyAfterError:
		return stepStop, tries
	case e.Resume == store.ResumeResumed && e.For == e.At:
		return stepAwait, tries
	case tries >= resumeMaxTries:
		return stepGiveUp, tries
	case f.Now.Before(time.UnixMilli(e.At).Add(resumeBackoff[tries])):
		return stepWait, tries
	}
	return stepResume, tries
}

// covered reports whether a step leaves the error to Caprock for now, so
// the alert its failed turn raises is held back.
func (s resumeStep) covered() bool {
	return s == stepWait || s == stepAwait || s == stepResume
}

// apiResumePoll is how often the watcher looks: the shortest pause is a
// minute, so a few seconds late is nothing.
const apiResumePoll = 15 * time.Second

func (d *Daemon) apiResumeLoop(ctx context.Context) {
	t := time.NewTicker(apiResumePoll)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			d.apiResumeTick(ctx, time.Now())
		}
	}
}

// apiResumeTick acts once on every owned session standing on an API error.
func (d *Daemon) apiResumeTick(ctx context.Context, now time.Time) {
	if d.queue == nil || !d.config().ResumeAfterAPIErrorOn() {
		return
	}
	list, err := store.OwnedAtAPIError(ctx, d.store.DB())
	if err != nil {
		d.log.Warn("could not read sessions at an API error", "component", "api-resume", "err", err)
		return
	}
	for _, s := range list {
		d.apiResumeOne(ctx, s, now)
	}
}

// resumeFactsOf gathers what decideResume reads; ok is false for a session
// that is not one to type into: not Caprock's, not Claude Code, or replaced.
func (d *Daemon) resumeFactsOf(ctx context.Context, s store.Session, now time.Time) (resumeFacts, bool) {
	if s.APIError == nil {
		return resumeFacts{}, false
	}
	if a := s.Agent; a != "" && a != agents.AgentClaude {
		return resumeFacts{}, false
	}
	ag, ok := d.queue.owned(s.SessionID)
	if !ok || ag.Current() != s.SessionID {
		return resumeFacts{}, false
	}
	e := *s.APIError
	f := resumeFacts{Err: e, Now: now}
	prompts, err := store.LastEventsFiltered(ctx, d.store.DB(), s.SessionID, 20,
		store.EventFilter{MainOnly: true, Kinds: []string{string(event.KindTurnUser)}})
	if err != nil {
		return resumeFacts{}, false
	}
	for _, p := range prompts {
		if ownResumePrompt(p, e.ResumedAt) {
			continue
		}
		ts := p.Ts.UnixMilli()
		if ts > e.At {
			f.PromptAfterError = true
		}
		if e.ResumedAt > 0 && ts > e.ResumedAt {
			f.PromptAfterResume = true
		}
	}
	if k, ok := d.queue.sess.(interface{ LastKey(string) time.Time }); ok {
		if at := k.LastKey(s.SessionID); !at.IsZero() && at.UnixMilli() > e.At {
			f.KeyAfterError = true
		}
	}
	return f, true
}

// ownResumePrompt reports whether a prompt event is one Caprock typed after
// an API error: marked so, or — should the transcript's copy be the one
// kept — the same word within a couple of minutes of the last try.
func ownResumePrompt(p event.Event, resumedAt int64) bool {
	if payloadString(p.Payload, "via") == viaAutoResume {
		return true
	}
	if resumedAt <= 0 || strings.TrimSpace(payloadString(p.Payload, "prompt")) != autoResumeText {
		return false
	}
	d := p.Ts.Sub(time.UnixMilli(resumedAt))
	return d > -10*time.Second && d < 2*time.Minute
}

// apiResumeOne decides about one session and does it.
func (d *Daemon) apiResumeOne(ctx context.Context, s store.Session, now time.Time) {
	f, ok := d.resumeFactsOf(ctx, s, now)
	if !ok {
		return
	}
	step, tries := decideResume(f)
	e := f.Err
	switch step {
	case stepStop:
		if d.setResume(ctx, s.SessionID, e.At, store.ResumeStopped, tries, 0) {
			d.log.Info("API error: the user is at the session; not resuming it", "component", "api-resume", "session", s.SessionID, "reason", e.Reason)
		}
	case stepGiveUp:
		if d.setResume(ctx, s.SessionID, e.At, store.ResumeGaveUp, tries, 0) {
			d.log.Info("API error: gave up after the automatic tries", "component", "api-resume", "session", s.SessionID, "tries", tries, "reason", e.Reason)
		}
	case stepResume:
		sent, err := d.queue.resumeAfterError(ctx, s.SessionID)
		if err != nil {
			d.log.Warn("API error: could not type continue", "component", "api-resume", "session", s.SessionID, "err", err)
			return
		}
		if !sent {
			return // not at its prompt, or something waits in the queue: the next tick looks again
		}
		d.setResume(ctx, s.SessionID, e.At, store.ResumeResumed, tries+1, now.UnixMilli())
		d.log.Info("API error: resumed the session", "component", "api-resume", "session", s.SessionID, "try", tries+1, "of", resumeMaxTries, "reason", e.Reason)
	}
}

// setResume writes the resume state and tells every open dashboard.
func (d *Daemon) setResume(ctx context.Context, id string, forAt int64, state string, tries int, at int64) bool {
	ok, err := store.SetAPIResume(ctx, d.store.DB(), id, forAt, state, tries, at)
	if err != nil {
		d.log.Warn("API error: could not record the resume", "component", "api-resume", "session", id, "err", err)
		return false
	}
	if ok {
		d.publishSessionRow(ctx, id)
	}
	return ok
}

// publishSessionRow sends a session's row as a live frame.
func (d *Daemon) publishSessionRow(ctx context.Context, id string) {
	if d.bus == nil {
		return
	}
	s, err := store.GetSession(ctx, d.store.DB(), id)
	if err != nil {
		return
	}
	st, _ := store.GetStats(ctx, d.store.DB(), id)
	d.bus.Publish(bus.Frame{Type: bus.FrameSession, Data: rollup.SessionFrame{Session: s, Stats: st}})
}

// apiResumeCovers reports whether Caprock is still answering the API error
// a failed turn of session id ended on, so the alert for that turn is held
// back: the give-up's alert goes, with the tries it made.
func (d *Daemon) apiResumeCovers(ctx context.Context, id string) bool {
	if d.queue == nil || !d.config().ResumeAfterAPIErrorOn() {
		return false
	}
	s, err := store.GetSession(ctx, d.store.DB(), id)
	if err != nil || s.APIError == nil || !s.Owned || s.Status == "ended" {
		return false
	}
	f, ok := d.resumeFactsOf(ctx, s, time.Now())
	if !ok {
		return false
	}
	step, _ := decideResume(f)
	return step.covered()
}

// apiResumeTries is how many times Caprock typed "continue" before giving
// up on the incident a failed turn belongs to, for its alert: the stored
// give-up, or the last try's turn failing again before the watcher's next
// tick has written it; 0 otherwise.
func (d *Daemon) apiResumeTries(s store.Session) int {
	if s.APIError == nil || s.APIError.At <= 0 {
		return 0
	}
	e := s.APIError
	if e.Resume == store.ResumeGaveUp || (e.Resume == store.ResumeResumed && e.Tries >= resumeMaxTries && e.For != e.At) {
		return e.Tries
	}
	return 0
}

// resumeAfterError types "continue" into an owned Claude Code session that
// sits at its prompt with nothing in its queue, marking the prompt it
// becomes; false when it is not at its prompt now.
func (q *msgQueue) resumeAfterError(ctx context.Context, id string) (bool, error) {
	unlock := q.lock(id)
	defer unlock()
	a, ok := q.owned(id)
	if !ok {
		return false, api.ErrNotOwned
	}
	if a.Kind != "" && a.Kind != agents.AgentClaude {
		return false, nil
	}
	v, err := q.view(ctx, a)
	if err != nil {
		return false, err
	}
	if v.Waiting != "" || len(v.Messages) > 0 {
		return false, nil
	}
	if err := q.typeLocked(id, autoResumeText, viaAutoResume); err != nil {
		return false, err
	}
	v.Waiting = api.WaitingTurn
	q.publish(v)
	return true, nil
}
