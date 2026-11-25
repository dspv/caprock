package daemon

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/store"
)

func TestDecideResume(t *testing.T) {
	at := time.Date(2026, 11, 25, 9, 0, 0, 0, time.UTC)
	ms := at.UnixMilli()
	err := func(mod func(e *store.APIError)) store.APIError {
		e := store.APIError{At: ms, Reason: "529 Overloaded", Retryable: true}
		if mod != nil {
			mod(&e)
		}
		return e
	}
	for _, c := range []struct {
		name  string
		f     resumeFacts
		step  resumeStep
		tries int
	}{
		{"waits the first minute", resumeFacts{Err: err(nil), Now: at.Add(30 * time.Second)}, stepWait, 0},
		{"first try after a minute", resumeFacts{Err: err(nil), Now: at.Add(time.Minute)}, stepResume, 0},
		{"not retryable", resumeFacts{Err: err(func(e *store.APIError) { e.Retryable = false }), Now: at.Add(time.Hour)}, stepNone, 0},
		{"the try's turn is running", resumeFacts{Err: err(func(e *store.APIError) {
			e.Resume, e.Tries, e.For, e.ResumedAt = store.ResumeResumed, 1, ms, ms+60_000
		}), Now: at.Add(time.Hour)}, stepAwait, 1},
		{"second error waits five minutes", resumeFacts{Err: err(func(e *store.APIError) {
			e.Resume, e.Tries, e.For, e.ResumedAt = store.ResumeResumed, 1, ms-120_000, ms-60_000
		}), Now: at.Add(4 * time.Minute)}, stepWait, 1},
		{"second try after five", resumeFacts{Err: err(func(e *store.APIError) {
			e.Resume, e.Tries, e.For, e.ResumedAt = store.ResumeResumed, 1, ms-120_000, ms-60_000
		}), Now: at.Add(5 * time.Minute)}, stepResume, 1},
		{"third try after fifteen", resumeFacts{Err: err(func(e *store.APIError) {
			e.Resume, e.Tries, e.For, e.ResumedAt = store.ResumeResumed, 2, ms-120_000, ms-60_000
		}), Now: at.Add(14 * time.Minute)}, stepWait, 2},
		{"gives up after three", resumeFacts{Err: err(func(e *store.APIError) {
			e.Resume, e.Tries, e.For, e.ResumedAt = store.ResumeResumed, 3, ms-120_000, ms-60_000
		}), Now: at.Add(time.Hour)}, stepGiveUp, 3},
		{"gave up stays given up", resumeFacts{Err: err(func(e *store.APIError) {
			e.Resume, e.Tries, e.For, e.ResumedAt = store.ResumeGaveUp, 3, ms, ms-60_000
		}), Now: at.Add(time.Hour)}, stepNone, 3},
		{"the user's message after a give-up starts a new incident", resumeFacts{Err: err(func(e *store.APIError) {
			e.Resume, e.Tries, e.For, e.ResumedAt = store.ResumeGaveUp, 3, ms-600_000, ms-900_000
		}), Now: at.Add(time.Minute), PromptAfterResume: true}, stepResume, 0},
		{"a recovered incident starts again", resumeFacts{Err: err(func(e *store.APIError) {
			e.Resume, e.Tries, e.ResumedAt = store.ResumeRecovered, 2, ms-900_000
		}), Now: at.Add(time.Minute)}, stepResume, 0},
		{"the user sent a message after the error", resumeFacts{Err: err(nil), Now: at.Add(time.Hour), PromptAfterError: true}, stepNone, 0},
		{"the user typed in the terminal", resumeFacts{Err: err(nil), Now: at.Add(time.Hour), KeyAfterError: true}, stepStop, 0},
		{"stopped for this error stays stopped", resumeFacts{Err: err(func(e *store.APIError) {
			e.Resume, e.For = store.ResumeStopped, ms
		}), Now: at.Add(time.Hour)}, stepNone, 0},
	} {
		step, tries := decideResume(c.f)
		if step != c.step || tries != c.tries {
			t.Errorf("%s: step %d tries %d, want %d %d", c.name, step, tries, c.step, c.tries)
		}
	}
	if !stepWait.covered() || !stepAwait.covered() || !stepResume.covered() || stepGiveUp.covered() || stepStop.covered() || stepNone.covered() {
		t.Fatal("covered: only waiting, awaiting and resuming hold the alert back")
	}
}

// keyedFake is the agent manager with the last key a person typed.
type keyedFake struct {
	*fakeSessions
	mu   sync.Mutex
	keys map[string]time.Time
}

func (k *keyedFake) LastKey(id string) time.Time {
	k.mu.Lock()
	defer k.mu.Unlock()
	return k.keys[id]
}

// resumeSession stores an owned Claude Code session at its prompt (its
// SessionStart recorded) whose turn ended on an API error at errAt.
func resumeSession(t *testing.T, q *msgQueue, f *fakeSessions, d *Daemon, id string, errAt time.Time, retry bool) {
	t.Helper()
	ctx := context.Background()
	db := d.store.DB()
	if err := store.UpsertSession(ctx, db, id, store.SessionPatch{Cwd: "/r"}); err != nil {
		t.Fatal(err)
	}
	if err := store.MarkOwned(ctx, db, id, "", "claude", 1); err != nil {
		t.Fatal(err)
	}
	set(f, f.owned, id, agents.AgentClaude)
	hook(t, q, d, id, event.KindAgentSpawn, map[string]any{"source": "startup"}, false)
	if err := store.SetAPIError(ctx, db, id, store.APIError{At: errAt.UnixMilli(), Reason: "529 Overloaded", Retryable: retry}); err != nil {
		t.Fatal(err)
	}
}

func apiErrOf(t *testing.T, d *Daemon, id string) store.APIError {
	t.Helper()
	s, err := store.GetSession(context.Background(), d.store.DB(), id)
	if err != nil || s.APIError == nil {
		t.Fatalf("session %s: %+v %v", id, s.APIError, err)
	}
	return *s.APIError
}

func TestResumeAfterAPIErrorTypesContinueWithBackoffAndCap(t *testing.T) {
	q, f, d := newTestQueue(t)
	d.queue = q
	ctx := context.Background()
	errAt := time.Now().Add(-30 * time.Second)
	resumeSession(t, q, f, d, "s1", errAt, true)

	d.apiResumeTick(ctx, errAt.Add(30*time.Second))
	if got := f.got("s1"); got != "" {
		t.Fatalf("typed before the minute was up: %q", got)
	}
	if !d.apiResumeCovers(ctx, "s1") {
		t.Fatal("the failed turn's alert must be held while Caprock answers it")
	}
	d.apiResumeTick(ctx, errAt.Add(time.Minute))
	if got := f.got("s1"); !strings.Contains(got, autoResumeText) {
		t.Fatalf("typed %q, want continue", got)
	}
	e := apiErrOf(t, d, "s1")
	if e.Resume != store.ResumeResumed || e.Tries != 1 || e.For != errAt.UnixMilli() || e.ResumedAt == 0 {
		t.Fatalf("after the first try: %+v", e)
	}
	// The prompt it became is marked, so the history says whose it was.
	prompt := &event.Event{SessionID: "s1", Kind: event.KindTurnUser, Payload: json.RawMessage(`{"prompt":"continue"}`)}
	q.annotate(prompt)
	if payloadString(prompt.Payload, "via") != viaAutoResume {
		t.Fatalf("the prompt was not marked: %s", prompt.Payload)
	}
	// The same error is never answered twice.
	before := len(f.writesOf("s1"))
	d.apiResumeTick(ctx, errAt.Add(time.Hour))
	if len(f.writesOf("s1")) != before {
		t.Fatal("typed again for the same error")
	}

	// Each try's turn fails again: five minutes, then fifteen, then a give-up.
	q.mu.Lock()
	delete(q.typed, "s1")
	q.mu.Unlock()
	hook(t, q, d, "s1", event.KindThrottle, map[string]any{"error": "server_error"}, false)
	at := errAt
	for try, wait := range []time.Duration{5 * time.Minute, 15 * time.Minute} {
		at = at.Add(2 * time.Hour)
		if err := store.SetAPIError(ctx, d.store.DB(), "s1", store.APIError{At: at.UnixMilli(), Reason: "529 Overloaded", Retryable: true}); err != nil {
			t.Fatal(err)
		}
		writes := len(f.writesOf("s1"))
		d.apiResumeTick(ctx, at.Add(wait-time.Second))
		if len(f.writesOf("s1")) != writes {
			t.Fatalf("try %d went in before its pause", try+2)
		}
		d.apiResumeTick(ctx, at.Add(wait))
		if len(f.writesOf("s1")) == writes {
			t.Fatalf("try %d did not go in", try+2)
		}
		q.mu.Lock()
		delete(q.typed, "s1")
		q.mu.Unlock()
		if e := apiErrOf(t, d, "s1"); e.Tries != try+2 {
			t.Fatalf("tries = %d, want %d", e.Tries, try+2)
		}
	}
	at = at.Add(2 * time.Hour)
	if err := store.SetAPIError(ctx, d.store.DB(), "s1", store.APIError{At: at.UnixMilli(), Reason: "529 Overloaded", Retryable: true}); err != nil {
		t.Fatal(err)
	}
	s, _ := store.GetSession(ctx, d.store.DB(), "s1")
	if d.apiResumeTries(s) != resumeMaxTries {
		t.Fatalf("the give-up alert must name the tries before the watcher writes it: %+v", s.APIError)
	}
	writes := len(f.writesOf("s1"))
	d.apiResumeTick(ctx, at.Add(time.Hour))
	if len(f.writesOf("s1")) != writes {
		t.Fatal("a fourth try went in")
	}
	if e := apiErrOf(t, d, "s1"); e.Resume != store.ResumeGaveUp || e.Tries != resumeMaxTries {
		t.Fatalf("after the third try failed: %+v", e)
	}
	if d.apiResumeCovers(ctx, "s1") {
		t.Fatal("the give-up's alert must go")
	}
	s, _ = store.GetSession(ctx, d.store.DB(), "s1")
	if d.apiResumeTries(s) != resumeMaxTries {
		t.Fatalf("the give-up alert must name the tries: %+v", s.APIError)
	}
}

// Rule 7: a session Caprock did not start is never typed into, and nothing
// is when the setting is off or the error is not one to retry.
func TestResumeAfterAPIErrorOnlyOwnedRetryableAndOn(t *testing.T) {
	q, f, d := newTestQueue(t)
	d.queue = q
	ctx := context.Background()
	errAt := time.Now().Add(-time.Hour)
	resumeSession(t, q, f, d, "mine", errAt, true)
	resumeSession(t, q, f, d, "auth", errAt, false)
	// Observed only: in the database as owned by an earlier daemon, but not
	// held by this one's manager.
	resumeSession(t, q, f, d, "theirs", errAt, true)
	f.mu.Lock()
	delete(f.owned, "theirs")
	f.mu.Unlock()

	off := false
	d.opt.Config.ResumeAfterAPIError = &off
	d.apiResumeTick(ctx, time.Now())
	if f.got("mine") != "" {
		t.Fatal("typed with the setting off")
	}
	d.opt.Config.ResumeAfterAPIError = nil // on by default
	d.apiResumeTick(ctx, time.Now())
	if !strings.Contains(f.got("mine"), autoResumeText) {
		t.Fatal("the owned session was not resumed")
	}
	if f.got("auth") != "" || f.got("theirs") != "" {
		t.Fatalf("typed into auth %q / theirs %q", f.got("auth"), f.got("theirs"))
	}
	if d.apiResumeCovers(ctx, "auth") || d.apiResumeCovers(ctx, "theirs") {
		t.Fatal("an alert was held for an error Caprock does not answer")
	}
}

// The user acting stops it: a key in the terminal, or a message they sent.
func TestResumeAfterAPIErrorStopsWhenTheUserActs(t *testing.T) {
	q, f, d := newTestQueue(t)
	kf := &keyedFake{fakeSessions: f, keys: map[string]time.Time{}}
	q.sess = kf
	d.queue = q
	ctx := context.Background()
	errAt := time.Now().Add(-time.Hour)
	resumeSession(t, q, f, d, "typed", errAt, true)
	resumeSession(t, q, f, d, "sent", errAt, true)
	kf.mu.Lock()
	kf.keys["typed"] = errAt.Add(10 * time.Second)
	kf.mu.Unlock()
	hook(t, q, d, "sent", event.KindTurnUser, map[string]any{"prompt": "try the other approach"}, false)

	d.apiResumeTick(ctx, time.Now())
	if f.got("typed") != "" || f.got("sent") != "" {
		t.Fatalf("typed into a session the user took over: %q / %q", f.got("typed"), f.got("sent"))
	}
	if e := apiErrOf(t, d, "typed"); e.Resume != store.ResumeStopped {
		t.Fatalf("typed: %+v", e)
	}
	// Once stopped, later ticks leave the same error alone.
	kf.mu.Lock()
	delete(kf.keys, "typed")
	kf.mu.Unlock()
	d.apiResumeTick(ctx, time.Now())
	if f.got("typed") != "" {
		t.Fatal("typed after the user took over")
	}
}

// A session in a turn, or with a message waiting in its queue, is not typed
// into: the next tick looks again.
func TestResumeAfterAPIErrorWaitsForThePrompt(t *testing.T) {
	q, f, d := newTestQueue(t)
	d.queue = q
	ctx := context.Background()
	errAt := time.Now().Add(-time.Hour)
	resumeSession(t, q, f, d, "s1", errAt, true)
	set(f, f.prompt, "s1", true)
	d.apiResumeTick(ctx, time.Now())
	if f.got("s1") != "" {
		t.Fatal("typed into a permission prompt")
	}
	if e := apiErrOf(t, d, "s1"); e.Tries != 0 {
		t.Fatalf("a try that did not go in was counted: %+v", e)
	}
	set(f, f.prompt, "s1", false)
	d.apiResumeTick(ctx, time.Now())
	if !strings.Contains(f.got("s1"), autoResumeText) {
		t.Fatal("not resumed once the prompt was gone")
	}
}
