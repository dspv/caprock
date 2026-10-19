package daemon

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/store"
)

// A forward from Telegram (ADR-081) goes through the queue like any
// message: typed now at the prompt, held mid-turn. The held row says it
// came from Telegram, the queue says when it went in, and the prompt event
// it becomes carries `via` for the chat's mark — that prompt only.
func TestQueueCarriesATelegramForward(t *testing.T) {
	q, f, d := newTestQueue(t)
	ctx := context.Background()
	var mu sync.Mutex
	var typed []store.QueuedMessage
	q.onTyped = func(m store.QueuedMessage) {
		mu.Lock()
		typed = append(typed, m)
		mu.Unlock()
	}
	set(f, f.owned, "s9", agents.AgentClaude)
	hook(t, q, d, "s9", event.KindAgentSpawn, map[string]any{"source": "startup"}, false)

	res, err := q.SendVia(ctx, "s9", "> Forwarded from Alice\n> hi", viaTelegram)
	if err != nil || !res.Sent {
		t.Fatalf("at the prompt: %+v %v", res, err)
	}
	prompt := &event.Event{SessionID: "s9", Kind: event.KindTurnUser, Payload: json.RawMessage(`{"prompt":"> Forwarded from Alice\n> hi","n":12345678901234567}`)}
	q.annotate(prompt)
	var p map[string]json.RawMessage
	if err := json.Unmarshal(prompt.Payload, &p); err != nil || string(p["via"]) != `"telegram"` || string(p["n"]) != "12345678901234567" {
		t.Fatalf("payload = %s", prompt.Payload)
	}
	// The next prompt is the owner's own.
	next := &event.Event{SessionID: "s9", Kind: event.KindTurnUser, Payload: json.RawMessage(`{"prompt":"mine"}`)}
	q.annotate(next)
	if string(next.Payload) != `{"prompt":"mine"}` {
		t.Fatalf("a later prompt was marked: %s", next.Payload)
	}
	hook(t, q, d, "s9", event.KindTurnUser, nil, false)

	res, err = q.SendVia(ctx, "s9", "second forward", viaTelegram)
	if err != nil || res.Sent || res.Queued == nil || res.Queued.Via != viaTelegram {
		t.Fatalf("mid-turn: %+v %v", res, err)
	}
	if l := queued(t, d, "s9"); len(l) != 1 || l[0].Via != viaTelegram {
		t.Fatalf("stored row = %+v", l)
	}
	hook(t, q, d, "s9", event.KindAgentStop, nil, false)
	waitQueue(t, "the held forward typed in", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(typed) == 1
	})
	mu.Lock()
	got := typed[0]
	mu.Unlock()
	if got.ID != res.Queued.ID || got.Via != viaTelegram {
		t.Fatalf("onTyped got %+v", got)
	}
	marked := &event.Event{SessionID: "s9", Kind: event.KindTurnUser, Payload: json.RawMessage(`{"prompt":"second forward"}`)}
	q.annotate(marked)
	if !json.Valid(marked.Payload) || string(marked.Payload) == `{"prompt":"second forward"}` {
		t.Fatalf("the held forward's prompt was not marked: %s", marked.Payload)
	}

	// A mark is not left for a prompt that comes long after.
	q.markVia("s2", viaTelegram)
	q.now = func() time.Time { return time.Now().Add(time.Minute) }
	late := &event.Event{SessionID: "s2", Kind: event.KindTurnUser, Payload: json.RawMessage(`{"prompt":"x"}`)}
	q.annotate(late)
	if string(late.Payload) != `{"prompt":"x"}` {
		t.Fatalf("a stale mark was used: %s", late.Payload)
	}
}
