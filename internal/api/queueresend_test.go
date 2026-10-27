package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/store"
)

// resendQueue is a queue holding undelivered messages for one ended session.
type resendQueue struct {
	fakeQueue
	undelivered map[string][]store.QueuedMessage
	resends     []string
}

func (f *resendQueue) View(_ context.Context, id string) (QueueView, error) {
	return QueueView{SessionID: id, Messages: []store.QueuedMessage{}, Undelivered: f.undelivered[id]}, nil
}

func (f *resendQueue) Resend(_ context.Context, from, to string, ids []int64, spawned bool) (QueueView, error) {
	b, _ := json.Marshal(ids)
	f.resends = append(f.resends, from+">"+to+" "+string(b)+map[bool]string{true: " spawned", false: ""}[spawned])
	return QueueView{SessionID: to, Messages: f.undelivered[from]}, nil
}

// Send to a new session (ADR-053, 2026-10-27): the ended conversation is
// continued when it can be, else a fresh session of the same agent starts
// in its folder; the messages are handed to the new session's queue.
func TestQueueResendStartsASessionAndHandsTheMessagesOver(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	dir := t.TempDir()
	// Claude Code without a transcript on disk cannot be resumed: fresh.
	if err := store.UpsertSession(ctx, e.st.DB(), "c1", store.SessionPatch{Cwd: dir, Agent: "claude"}); err != nil {
		t.Fatal(err)
	}
	// A Codex session it can find by id: resumed.
	if err := store.UpsertSession(ctx, e.st.DB(), "x1", store.SessionPatch{Cwd: dir, Agent: "codex", Status: store.StatusEnded}); err != nil {
		t.Fatal(err)
	}
	m := func(id int64, sid string) store.QueuedMessage {
		return store.QueuedMessage{ID: id, SessionID: sid, Text: "t", UndeliveredAt: 1}
	}
	q := &resendQueue{undelivered: map[string][]store.QueuedMessage{
		"c1": {m(1, "c1"), m(2, "c1")}, "x1": {m(3, "x1")}, "live": {m(4, "live")},
	}}
	fa := &fakeAgents{avail: true, held: map[string]bool{"live": true}}
	h := New(Deps{Store: e.st, Version: "t", Token: "tok", Now: func() time.Time { return e.now }, Agents: fa, Queue: q})
	do := func(path, body string, out any) int {
		req := httptest.NewRequest(http.MethodPost, path, bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if out != nil {
			_ = json.Unmarshal(rr.Body.Bytes(), out)
		}
		return rr.Code
	}

	var res ResendResult
	if code := do("/v1/agents/c1/queue/resend", `{"ids":[2]}`, &res); code != 200 {
		t.Fatalf("resend: %d", code)
	}
	last := fa.spawns[len(fa.spawns)-1]
	if res.SessionID != "new-session" || res.Resumed || !res.Started || last["agent"] != "claude" || last["cwd"] != dir || last["resume"] != nil {
		t.Fatalf("fresh start: %+v %v", res, last)
	}
	if got := q.resends[len(q.resends)-1]; got != "c1>new-session [2] spawned" {
		t.Fatalf("hand-over: %q", got)
	}

	if code := do("/v1/agents/x1/queue/resend", ``, &res); code != 200 {
		t.Fatalf("resend all: %d", code)
	}
	last = fa.spawns[len(fa.spawns)-1]
	if !res.Resumed || last["resume"] != "x1" || last["fork"] != false {
		t.Fatalf("resume: %+v %v", res, last)
	}
	if got := q.resends[len(q.resends)-1]; got != "x1>new-session null spawned" {
		t.Fatalf("hand-over: %q", got)
	}

	// A session that runs again takes them back; nothing is started.
	n := len(fa.spawns)
	if code := do("/v1/agents/live/queue/resend", `{}`, &res); code != 200 || res.Started || len(fa.spawns) != n {
		t.Fatalf("live: %d %+v", code, res)
	}
	// An id that is not undelivered there.
	if code := do("/v1/agents/c1/queue/resend", `{"ids":[99]}`, nil); code != http.StatusNotFound {
		t.Fatalf("unknown id: %d", code)
	}
	if code := do("/v1/agents/nothing/queue/resend", ``, nil); code != http.StatusNotFound {
		t.Fatalf("nothing undelivered: %d", code)
	}
	if code := do("/v1/agents/c1/queue/resend", `nope`, nil); code != http.StatusBadRequest {
		t.Fatalf("bad body: %d", code)
	}
}
