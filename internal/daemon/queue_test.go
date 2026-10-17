package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/api"
	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/store"
)

// fakeSessions stands in for the agent manager: which sessions are
// Caprock's, which wait on a prompt, and what was typed into each.
type fakeSessions struct {
	mu     sync.Mutex
	owned  map[string]string // id → kind
	prompt map[string]bool
	typed  map[string]*strings.Builder
	// writes is every Input call, in order, with when it came.
	writes map[string][]fakeWrite
	// paste marks a session whose output turned bracketed paste on; holds
	// one whose screen still shows the message in its prompt.
	paste map[string]bool
	holds map[string]bool
}

type fakeWrite struct {
	data string
	at   time.Time
}

func newFakeSessions() *fakeSessions {
	return &fakeSessions{owned: map[string]string{}, prompt: map[string]bool{}, typed: map[string]*strings.Builder{},
		writes: map[string][]fakeWrite{}, paste: map[string]bool{}, holds: map[string]bool{}}
}

func (f *fakeSessions) PasteMode(id string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.paste[id]
}

func (f *fakeSessions) PromptHolds(id, _ string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.holds[id]
}

// set changes one of the fake's maps under its lock: a confirmation check
// may be reading them on its own goroutine.
func set[V any](f *fakeSessions, m map[string]V, id string, v V) {
	f.mu.Lock()
	defer f.mu.Unlock()
	m[id] = v
}

func (f *fakeSessions) writesOf(id string) []fakeWrite {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]fakeWrite(nil), f.writes[id]...)
}

func (f *fakeSessions) Get(id string) (*agents.Agent, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	kind, ok := f.owned[id]
	if !ok {
		return nil, false
	}
	return &agents.Agent{SessionID: id, Kind: kind}, true
}
func (f *fakeSessions) IsShell(string) bool { return false }
func (f *fakeSessions) OwnedRunning() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, 0, len(f.owned))
	for id := range f.owned {
		out = append(out, id)
	}
	return out
}
func (f *fakeSessions) PendingPermission(id string) (*agents.Permission, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.prompt[id] {
		return &agents.Permission{ID: "p1", Tool: "Bash"}, true
	}
	return nil, false
}
func (f *fakeSessions) Input(id string, data []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, ok := f.owned[id]; !ok {
		return errors.New("not owned")
	}
	if f.typed[id] == nil {
		f.typed[id] = &strings.Builder{}
	}
	f.typed[id].Write(data)
	f.writes[id] = append(f.writes[id], fakeWrite{data: string(data), at: time.Now()})
	return nil
}
func (f *fakeSessions) got(id string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.typed[id] == nil {
		return ""
	}
	return f.typed[id].String()
}

func newTestQueue(t *testing.T) (*msgQueue, *fakeSessions, *Daemon) {
	t.Helper()
	st, err := store.Open(context.Background(), ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	d := &Daemon{store: st, bus: bus.New(), log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	q := newMsgQueue(d)
	f := newFakeSessions()
	q.sess = f
	q.settle, q.gap, q.confirm = time.Millisecond, time.Millisecond, time.Millisecond
	return q, f, d
}

var evSeq int

// hook records a main-thread hook event the way hookd does, then tells the
// queue, as hookd's AfterMain does.
func hook(t *testing.T, q *msgQueue, d *Daemon, id string, kind event.Kind, payload map[string]any, continued bool) {
	t.Helper()
	evSeq++
	raw, _ := json.Marshal(payload)
	ev := &event.Event{SessionID: id, Source: event.SourceHook, Kind: kind, Ts: time.Now().Add(time.Duration(evSeq) * time.Millisecond), Payload: raw}
	if payload != nil {
		if tool, ok := payload["tool_name"].(string); ok {
			ev.Tool = tool
		}
	}
	if _, err := store.InsertEvent(context.Background(), d.store.DB(), ev); err != nil {
		t.Fatal(err)
	}
	q.afterMain(ev, continued)
}

func waitQueue(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func queued(t *testing.T, d *Daemon, id string) []store.QueuedMessage {
	t.Helper()
	m, err := store.ListQueued(context.Background(), d.store.DB(), id)
	if err != nil {
		t.Fatal(err)
	}
	return m
}

// At its prompt, a message is typed in at once; mid-turn it waits for the
// Stop, and the queue goes in one message per turn, oldest first.
func TestQueueDeliversOnePerTurnAfterStop(t *testing.T) {
	q, f, d := newTestQueue(t)
	ctx := context.Background()
	set(f, f.owned, "s1", agents.AgentClaude)
	hook(t, q, d, "s1", event.KindAgentSpawn, map[string]any{"source": "startup"}, false)

	res, err := q.Send(ctx, "s1", "first\nline two")
	if err != nil || !res.Sent {
		t.Fatalf("send at the prompt: %+v %v", res, err)
	}
	if got := f.got("s1"); got != "first\x1b\rline two\r" {
		t.Fatalf("typed %q", got)
	}
	// The prompt was submitted: the turn runs.
	hook(t, q, d, "s1", event.KindTurnUser, nil, false)
	hook(t, q, d, "s1", event.KindToolPre, map[string]any{"tool_name": "Bash"}, false)

	for _, m := range []string{"second", "third"} {
		res, err := q.Send(ctx, "s1", m)
		if err != nil || res.Sent || res.Queued == nil {
			t.Fatalf("send mid-turn should queue: %+v %v", res, err)
		}
		if res.Queue.Waiting != api.WaitingTurn {
			t.Fatalf("waiting = %q", res.Queue.Waiting)
		}
	}
	before := f.got("s1")
	hook(t, q, d, "s1", event.KindAgentStop, nil, false)
	waitQueue(t, "the second message", func() bool { return f.got("s1") == before+"second\r" })
	if l := queued(t, d, "s1"); len(l) != 1 || l[0].Text != "third" {
		t.Fatalf("left in the queue: %+v", l)
	}
	// Only one per turn: nothing more until the next Stop.
	time.Sleep(30 * time.Millisecond)
	if f.got("s1") != before+"second\r" {
		t.Fatalf("typed more than one per turn: %q", f.got("s1"))
	}
	hook(t, q, d, "s1", event.KindTurnUser, nil, false)
	hook(t, q, d, "s1", event.KindAgentStop, nil, false)
	waitQueue(t, "the third message", func() bool { return f.got("s1") == before+"second\rthird\r" })
	if l := queued(t, d, "s1"); len(l) != 0 {
		t.Fatalf("queue not empty: %+v", l)
	}
}

// Never into a permission prompt or a question; a Stop the task runner
// turned back is not the end of a turn.
func TestQueueHoldsForPromptsAndContinuedStops(t *testing.T) {
	q, f, d := newTestQueue(t)
	ctx := context.Background()
	set(f, f.owned, "s1", agents.AgentClaude)
	hook(t, q, d, "s1", event.KindAgentSpawn, map[string]any{"source": "startup"}, false)

	set(f, f.prompt, "s1", true)
	res, err := q.Send(ctx, "s1", "hello")
	if err != nil || res.Sent || res.Queue.Waiting != api.WaitingPermission {
		t.Fatalf("send with a prompt waiting: %+v %v", res, err)
	}
	if _, err := q.SendNow(ctx, "s1", res.Queued.ID); !errors.Is(err, api.ErrPromptWaiting) {
		t.Fatalf("send now into a prompt: %v", err)
	}
	set(f, f.prompt, "s1", false)

	// The Stop-loop kept the turn going.
	hook(t, q, d, "s1", event.KindAgentStop, nil, true)
	time.Sleep(30 * time.Millisecond)
	if f.got("s1") != "" {
		t.Fatalf("typed after a continued stop: %q", f.got("s1"))
	}
	v, err := q.View(ctx, "s1")
	if err != nil || v.Waiting != api.WaitingTurn {
		t.Fatalf("view after a continued stop: %+v %v", v, err)
	}

	// A question asked with AskUserQuestion is not typed into either.
	hook(t, q, d, "s1", event.KindPermissionPrompt, map[string]any{"tool_name": "AskUserQuestion"}, false)
	if v, _ := q.View(ctx, "s1"); v.Waiting != api.WaitingQuestion {
		t.Fatalf("waiting = %q, want question", v.Waiting)
	}
	if _, err := q.SendNow(ctx, "s1", res.Queued.ID); !errors.Is(err, api.ErrPromptWaiting) {
		t.Fatalf("send now into a question: %v", err)
	}

	hook(t, q, d, "s1", event.KindAgentStop, nil, false)
	waitQueue(t, "delivery", func() bool { return f.got("s1") == "hello\r" })
}

// Edit keeps the place, cancel drops it, send now types it at once.
func TestQueueEditCancelSendNow(t *testing.T) {
	q, f, d := newTestQueue(t)
	ctx := context.Background()
	set(f, f.owned, "s1", agents.AgentClaude)
	hook(t, q, d, "s1", event.KindTurnUser, nil, false)
	hook(t, q, d, "s1", event.KindAgentSpawn, map[string]any{"source": "compact"}, false) // not a fresh prompt

	a, _ := q.Send(ctx, "s1", "a")
	b, _ := q.Send(ctx, "s1", "b")
	c, _ := q.Send(ctx, "s1", "c")
	if a.Queued == nil || b.Queued == nil || c.Queued == nil {
		t.Fatal("expected all three queued")
	}
	if _, err := q.Edit(ctx, "s1", a.Queued.ID, "a2"); err != nil {
		t.Fatal(err)
	}
	if _, err := q.Cancel(ctx, "s1", b.Queued.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := q.Cancel(ctx, "s1", b.Queued.ID); !errors.Is(err, store.ErrQueuedNotFound) {
		t.Fatalf("second cancel: %v", err)
	}
	v, err := q.SendNow(ctx, "s1", c.Queued.ID)
	if err != nil {
		t.Fatal(err)
	}
	if f.got("s1") != "c\r" || len(v.Messages) != 1 || v.Messages[0].Text != "a2" {
		t.Fatalf("typed %q, left %+v", f.got("s1"), v.Messages)
	}
}

// Rule 7, the session's end, other agents and sessions without hooks.
func TestQueueOwnershipEndAndUnknownTurns(t *testing.T) {
	q, f, d := newTestQueue(t)
	ctx := context.Background()

	if _, err := q.Send(ctx, "not-ours", "x"); !errors.Is(err, api.ErrNotOwned) {
		t.Fatalf("send to a session Caprock did not start: %v", err)
	}

	// Codex says no turn end: typed at once, as before.
	set(f, f.owned, "cx", "codex")
	hook(t, q, d, "cx", event.KindToolPre, map[string]any{"tool_name": "shell"}, false)
	if res, err := q.Send(ctx, "cx", "go"); err != nil || !res.Sent || f.got("cx") != "go\r" {
		t.Fatalf("codex send: %+v %v %q", res, err, f.got("cx"))
	}

	// Claude Code whose hooks record nothing: typed at once too.
	set(f, f.owned, "nohooks", agents.AgentClaude)
	ev := &event.Event{SessionID: "nohooks", Source: event.SourceTranscript, Kind: event.KindToolPre, Ts: time.Now()}
	if _, err := store.InsertEvent(ctx, d.store.DB(), ev); err != nil {
		t.Fatal(err)
	}
	if res, err := q.Send(ctx, "nohooks", "go"); err != nil || !res.Sent {
		t.Fatalf("send without hooks: %+v %v", res, err)
	}

	// A session that ends loses its queue.
	set(f, f.owned, "s1", agents.AgentClaude)
	hook(t, q, d, "s1", event.KindTurnUser, nil, false)
	if res, _ := q.Send(ctx, "s1", "later"); res.Queued == nil {
		t.Fatal("expected queued")
	}
	f.mu.Lock()
	delete(f.owned, "s1")
	f.mu.Unlock()
	q.ended("s1")
	if l := queued(t, d, "s1"); len(l) != 0 {
		t.Fatalf("queue survived the end: %+v", l)
	}

	// Full at QueueMax.
	set(f, f.owned, "s2", agents.AgentClaude)
	hook(t, q, d, "s2", event.KindTurnUser, nil, false)
	for i := 0; i < api.QueueMax; i++ {
		if _, err := q.Send(ctx, "s2", "m"); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := q.Send(ctx, "s2", "one too many"); !errors.Is(err, api.ErrQueueFull) {
		t.Fatalf("21st: %v", err)
	}
}

func TestPromptBytes(t *testing.T) {
	got := promptBytes("a\tb\r\nc\x1b[31md\u0085é")
	if got != "a  b\x1b\rc[31mdé" {
		t.Fatalf("%q", got)
	}
	for in, want := range map[string]string{
		"look at @src/a.go": "look at @src/a.go ",
		"@a.go":             "@a.go ",
		"mail me@x.io":      "mail me@x.io",
		"done":              "done",
	} {
		if got := promptBytes(in); got != want {
			t.Errorf("promptBytes(%q) = %q, want %q", in, got, want)
		}
	}
}

// The 2026-10-17 bug: a "Tell the agent" message sat typed in a Codex
// prompt and was never sent. A message is two writes — the text, then the
// Enter after a pause — and to a session that turned bracketed paste on the
// text goes as a paste, so the Enter after it cannot be read into it.
func TestTypeMessageWriteSequence(t *testing.T) {
	msg := "[Caprock] Heads-up: you ran `write_stdin` 5 times.\nTry another way — or say what blocks."
	for _, tc := range []struct {
		name  string
		paste bool
		body  string
	}{
		{"typed", false, "[Caprock] Heads-up: you ran `write_stdin` 5 times.\x1b\rTry another way — or say what blocks."},
		{"pasted", true, "\x1b[200~[Caprock] Heads-up: you ran `write_stdin` 5 times.\rTry another way — or say what blocks.\x1b[201~"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newFakeSessions()
			set(f, f.owned, "s1", "codex")
			set(f, f.paste, "s1", tc.paste)
			var told time.Time
			gap := 20 * time.Millisecond
			at, err := typeMessage(f, "s1", msg, gap, func(t time.Time) { told = t })
			if err != nil {
				t.Fatal(err)
			}
			w := f.writesOf("s1")
			if len(w) != 2 {
				t.Fatalf("%d writes, want the text and the Enter apart: %+v", len(w), w)
			}
			if w[0].data != tc.body || w[1].data != "\r" {
				t.Fatalf("writes %q, %q", w[0].data, w[1].data)
			}
			if d := w[1].at.Sub(w[0].at); d < gap {
				t.Fatalf("Enter came %v after the text, want at least %v", d, gap)
			}
			if !told.Equal(at) || at.IsZero() {
				t.Fatalf("typed told %v, returned %v", told, at)
			}
		})
	}
}

// An ESC inside a message would end a paste early and turn the rest into
// keys: it is dropped, as are other control characters.
func TestMessageBytesKeepsThePasteClosed(t *testing.T) {
	got := messageBytes("a\x1b[201~b\x03c\td\r\ne @x.go", true)
	if got != "\x1b[200~a[201~bc  d\re @x.go \x1b[201~" {
		t.Fatalf("%q", got)
	}
	if strings.Count(got, "\x1b") != 2 {
		t.Fatalf("an ESC got into the paste: %q", got)
	}
}

func TestEnterGapGrowsWithLength(t *testing.T) {
	gap := 200 * time.Millisecond
	for n, want := range map[int]time.Duration{
		10:      gap,
		300:     gap + 25*time.Millisecond,
		1024:    gap + 100*time.Millisecond,
		1 << 20: time.Second,
	} {
		if got := enterGap(gap, n); got != want {
			t.Errorf("enterGap(%d) = %v, want %v", n, got, want)
		}
	}
	if got := enterGap(2*time.Second, 1<<20); got != 2*time.Second {
		t.Errorf("a longer base gap must not be cut: %v", got)
	}
}

// When the prompt still holds the message after the Enter, Enter is pressed
// once more — and only then, only once, never into a menu, and not after the
// session's hooks said its turn started.
func TestQueueConfirmsTheMessageWent(t *testing.T) {
	ctx := context.Background()
	enters := func(f *fakeSessions, id string) int {
		n := 0
		for _, w := range f.writesOf(id) {
			if w.data == "\r" {
				n++
			}
		}
		return n
	}

	t.Run("still held: Enter again, once", func(t *testing.T) {
		q, f, _ := newTestQueue(t)
		set(f, f.owned, "cx", "codex")
		set(f, f.holds, "cx", true)
		if res, err := q.Send(ctx, "cx", "go on"); err != nil || !res.Sent {
			t.Fatalf("%+v %v", res, err)
		}
		waitQueue(t, "the second Enter", func() bool { return enters(f, "cx") == 2 })
		time.Sleep(30 * time.Millisecond)
		if n := enters(f, "cx"); n != 2 {
			t.Fatalf("%d Enters, want 2", n)
		}
	})

	t.Run("sent: no second Enter", func(t *testing.T) {
		q, f, _ := newTestQueue(t)
		set(f, f.owned, "cx", "codex")
		if _, err := q.Send(ctx, "cx", "go on"); err != nil {
			t.Fatal(err)
		}
		time.Sleep(50 * time.Millisecond)
		if n := enters(f, "cx"); n != 1 {
			t.Fatalf("%d Enters, want 1", n)
		}
	})

	t.Run("a menu came up: never Enter into it", func(t *testing.T) {
		q, f, _ := newTestQueue(t)
		q.confirm = 40 * time.Millisecond
		set(f, f.owned, "cx", "codex")
		set(f, f.holds, "cx", true)
		if _, err := q.Send(ctx, "cx", "go on"); err != nil {
			t.Fatal(err)
		}
		set(f, f.prompt, "cx", true)
		time.Sleep(100 * time.Millisecond)
		if n := enters(f, "cx"); n != 1 {
			t.Fatalf("%d Enters, want 1", n)
		}
	})

	t.Run("the hooks said the turn started", func(t *testing.T) {
		q, f, d := newTestQueue(t)
		q.confirm = 40 * time.Millisecond
		set(f, f.owned, "s1", agents.AgentClaude)
		hook(t, q, d, "s1", event.KindAgentSpawn, map[string]any{"source": "startup"}, false)
		set(f, f.holds, "s1", true) // the echo above the box, say
		if res, err := q.Send(ctx, "s1", "go on"); err != nil || !res.Sent {
			t.Fatalf("%+v %v", res, err)
		}
		hook(t, q, d, "s1", event.KindTurnUser, nil, false)
		time.Sleep(100 * time.Millisecond)
		if n := enters(f, "s1"); n != 1 {
			t.Fatalf("%d Enters, want 1", n)
		}
	})
}

func TestTurnWaitingReadsHookEventsOnly(t *testing.T) {
	mk := func(src event.Source, kind event.Kind, payload string) event.Event {
		return event.Event{Source: src, Kind: kind, Payload: json.RawMessage(payload)}
	}
	cases := []struct {
		name   string
		evs    []event.Event
		want   string
		hooked bool
	}{
		{"nothing", nil, "", false},
		{"transcript only", []event.Event{mk(event.SourceTranscript, event.KindTurnUser, `{}`)}, "", false},
		{"stop then transcript", []event.Event{mk(event.SourceHook, event.KindAgentStop, `{}`), mk(event.SourceTranscript, event.KindToolPost, `{}`)}, "", true},
		{"running", []event.Event{mk(event.SourceHook, event.KindAgentStop, `{}`), mk(event.SourceHook, event.KindTurnUser, `{}`)}, api.WaitingTurn, true},
		{"auto compact", []event.Event{mk(event.SourceHook, event.KindContextCompact, `{"trigger":"auto"}`), mk(event.SourceHook, event.KindAgentSpawn, `{"source":"compact"}`)}, api.WaitingTurn, true},
		{"manual compact", []event.Event{mk(event.SourceHook, event.KindAgentStop, `{}`), mk(event.SourceHook, event.KindContextCompact, `{"trigger":"manual"}`), mk(event.SourceHook, event.KindAgentSpawn, `{"source":"compact"}`)}, "", true},
		{"cleared", []event.Event{mk(event.SourceHook, event.KindTurnUser, `{}`), mk(event.SourceHook, event.KindContextClear, `{}`)}, "", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w, h := turnWaiting(tc.evs)
			if w != tc.want || h != tc.hooked {
				t.Fatalf("got (%q, %v), want (%q, %v)", w, h, tc.want, tc.hooked)
			}
		})
	}
}
