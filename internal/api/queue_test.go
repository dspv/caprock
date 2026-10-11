package api

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dspv/caprock/internal/store"
)

// fakeQueue records what reached it and answers as told.
type fakeQueue struct {
	sent []string
	err  error
}

func (f *fakeQueue) View(_ context.Context, id string) (QueueView, error) {
	return QueueView{SessionID: id, Messages: []store.QueuedMessage{}, Waiting: WaitingTurn}, f.err
}
func (f *fakeQueue) Send(_ context.Context, id, text string) (SendResult, error) {
	if f.err != nil {
		return SendResult{}, f.err
	}
	f.sent = append(f.sent, text)
	m := store.QueuedMessage{ID: 1, SessionID: id, Text: text}
	return SendResult{Queued: &m, Queue: QueueView{SessionID: id, Messages: []store.QueuedMessage{m}, Waiting: WaitingTurn}}, nil
}
func (f *fakeQueue) Edit(_ context.Context, id string, _ int64, _ string) (QueueView, error) {
	return QueueView{SessionID: id}, f.err
}
func (f *fakeQueue) Cancel(_ context.Context, id string, _ int64) (QueueView, error) {
	return QueueView{SessionID: id}, f.err
}
func (f *fakeQueue) SendNow(_ context.Context, id string, _ int64) (QueueView, error) {
	return QueueView{SessionID: id}, f.err
}

func TestQueueEndpoints(t *testing.T) {
	e := newEnv(t)
	if code := e.get(t, "/v1/agents/s1/queue", nil); code != http.StatusNotImplemented {
		t.Fatalf("no queue: %d", code)
	}
	q := &fakeQueue{}
	e.api.d.Queue = q

	var res SendResult
	if code := e.send(t, http.MethodPost, "/v1/agents/s1/queue", `{"text":"do the next thing\n\n"}`, &res); code != 200 {
		t.Fatalf("send: %d", code)
	}
	if len(q.sent) != 1 || q.sent[0] != "do the next thing" || res.Queued == nil {
		t.Fatalf("sent %q, answer %+v", q.sent, res)
	}
	for _, body := range []string{`{"text":"   "}`, `{"text":"a\u0000b"}`, `not json`, `{"text":"` + strings.Repeat("x", QueueTextMax+1) + `"}`} {
		if code := e.send(t, http.MethodPost, "/v1/agents/s1/queue", body, nil); code != http.StatusBadRequest {
			t.Errorf("body %.30q: %d, want 400", body, code)
		}
	}
	if code := e.send(t, http.MethodPatch, "/v1/agents/s1/queue/x", `{"text":"y"}`, nil); code != http.StatusBadRequest {
		t.Fatalf("bad id: %d", code)
	}
	for _, c := range []struct {
		err  error
		code int
	}{{store.ErrQueuedNotFound, 404}, {ErrNotOwned, 409}, {ErrPromptWaiting, 409}, {ErrQueueFull, 409}} {
		q.err = c.err
		if code := e.send(t, http.MethodPost, "/v1/agents/s1/queue/3/send", ``, nil); code != c.code {
			t.Errorf("%v: %d, want %d", c.err, code, c.code)
		}
	}
	q.err = nil
	if code := e.send(t, http.MethodDelete, "/v1/agents/s1/queue/3", ``, nil); code != 200 {
		t.Fatalf("cancel: %d", code)
	}
	if code := e.send(t, http.MethodPatch, "/v1/agents/s1/queue/3", `{"text":"new"}`, nil); code != 200 {
		t.Fatalf("edit: %d", code)
	}
}

func TestSessionPickers(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	dir := t.TempDir()
	home := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, ".claude", "commands"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".claude", "commands", "ship.md"), []byte("Ship it"), 0o644); err != nil {
		t.Fatal(err)
	}
	old := userHome
	userHome = func() (string, error) { return home, nil }
	t.Cleanup(func() { userHome = old })
	if err := store.UpsertSession(ctx, e.st.DB(), "s1", store.SessionPatch{Cwd: dir}); err != nil {
		t.Fatal(err)
	}

	var cmds struct {
		Agent    string
		Commands []struct{ Name, Source string }
	}
	if code := e.get(t, "/v1/sessions/s1/commands", &cmds); code != 200 {
		t.Fatalf("commands: %d", code)
	}
	found := false
	for _, c := range cmds.Commands {
		if c.Name == "ship" && c.Source == "project" {
			found = true
		}
	}
	if cmds.Agent != "claude" || !found {
		t.Fatalf("commands %+v", cmds)
	}
	if code := e.get(t, "/v1/sessions/nope/commands", nil); code != http.StatusNotFound {
		t.Fatalf("unknown session: %d", code)
	}
	// Files need the projects service; without it, 501.
	if code := e.get(t, "/v1/sessions/s1/files", nil); code != http.StatusNotImplemented {
		t.Fatalf("files without projects: %d", code)
	}
}

type fakeBoard struct{ b QueueBoard }

func (f fakeBoard) Board(context.Context) (QueueBoard, error) { return f.b, nil }

// GET /v1/queue answers the daemon's board as is; without one, 501.
func TestQueueBoardEndpoint(t *testing.T) {
	e := newEnv(t)
	if code := e.get(t, "/v1/queue", nil); code != http.StatusNotImplemented {
		t.Fatalf("no board: %d", code)
	}
	e.api.d.Board = fakeBoard{b: QueueBoard{Now: 5, Sessions: []BoardSession{{
		SessionID: "s1", Agent: "claude", Waiting: WaitingTurn,
		Queue:    []BoardItem{{QueuedMessage: store.QueuedMessage{ID: 7, Text: "next"}, Position: 1, Start: &ETA{LoMs: 1, MidMs: 2, HiMs: 3}}},
		Estimate: &Estimate{Turns: 18, MedianMs: 60000},
	}}, Done: []BoardDone{}}}
	var got map[string]any
	if code := e.get(t, "/v1/queue", &got); code != 200 {
		t.Fatalf("board: %d", code)
	}
	s := got["sessions"].([]any)[0].(map[string]any)
	item := s["queue"].([]any)[0].(map[string]any)
	if item["text"] != "next" || item["position"] != float64(1) || item["start"].(map[string]any)["mid_ms"] != float64(2) {
		t.Fatalf("item = %v", item)
	}
	if s["estimate"].(map[string]any)["turns"] != float64(18) || s["turn_left"] != nil {
		t.Fatalf("session = %v", s)
	}
}
