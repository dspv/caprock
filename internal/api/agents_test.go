package api

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

type fakeAgents struct {
	avail    bool
	inputs   []string
	sigs     []string
	snapshot []byte      // /term: snapshot returned on connect (nil ⇒ Term reports not-found)
	termCh   chan []byte // /term: output stream (nil ⇒ Term reports not-found)
}

func (f *fakeAgents) Available() bool { return f.avail }
func (f *fakeAgents) Spawn(_ context.Context, req any) (string, string, error) {
	m := req.(map[string]any)
	return "new-session", m["cwd"].(string), nil
}
func (f *fakeAgents) Input(_ string, d []byte) error {
	f.inputs = append(f.inputs, string(d))
	return nil
}
func (f *fakeAgents) Write(_ string, _ []byte) error  { return nil }
func (f *fakeAgents) Resize(_ string, _, _ int) error { return nil }
func (f *fakeAgents) Signal(_ string, a string) error { f.sigs = append(f.sigs, a); return nil }
func (f *fakeAgents) Term(string) ([]byte, <-chan []byte, func(), bool) {
	if f.termCh == nil {
		return nil, nil, nil, false
	}
	return f.snapshot, f.termCh, func() {}, true
}

func TestAgentsEndpoints(t *testing.T) {
	e := newEnv(t)
	fa := &fakeAgents{avail: true}
	// Re-create the server with agents wired.
	e.srv.Config.Handler = New(Deps{Store: e.st, Bus: nil, Table: nil, Version: "t", Token: "tok", Now: func() time.Time { return e.now }, Agents: fa})
	do := func(method, path, body string) *http.Response {
		req := httptest.NewRequest(method, path, bytes.NewBufferString(body))
		rr := httptest.NewRecorder()
		e.srv.Config.Handler.ServeHTTP(rr, req)
		return rr.Result()
	}
	if r := do("POST", "/v1/agents", `{"cwd":"/tmp/x","model":"claude-opus-5"}`); r.StatusCode != 200 {
		t.Fatalf("spawn: %d", r.StatusCode)
	}
	if r := do("POST", "/v1/agents/new-session/input", `{"data":"hi\n"}`); r.StatusCode != 204 || len(fa.inputs) != 1 || fa.inputs[0] != "hi\n" {
		t.Fatalf("input: %d %v", r.StatusCode, fa.inputs)
	}
	if r := do("POST", "/v1/agents/new-session/signal", `{"action":"kill"}`); r.StatusCode != 204 || len(fa.sigs) != 1 || fa.sigs[0] != "kill" {
		t.Fatalf("signal: %d %v", r.StatusCode, fa.sigs)
	}
	if r := do("POST", "/v1/agents/x/signal", `{"action":"bogus"}`); r.StatusCode != 400 {
		t.Fatalf("bad action: %d", r.StatusCode)
	}
	// Unavailable → 501.
	fa.avail = false
	if r := do("POST", "/v1/agents", `{"cwd":"/x"}`); r.StatusCode != http.StatusNotImplemented {
		t.Fatalf("unavailable spawn: %d", r.StatusCode)
	}
}

// The terminal WS (/v1/agents/{id}/term) must send the snapshot on connect and
// then stream subsequent output frames. This covers the serveTerm handler
// framing, which had no test (the manager-layer streaming is covered by the
// agents smoke test).
func TestTerminalWebSocketSnapshotAndStream(t *testing.T) {
	e := newEnv(t)
	fa := &fakeAgents{avail: true, snapshot: []byte("SNAP"), termCh: make(chan []byte, 4)}
	e.srv.Config.Handler = New(Deps{Store: e.st, Version: "t", Token: "tok",
		Now: func() time.Time { return e.now }, Agents: fa})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	wsURL := "ws" + strings.TrimPrefix(e.srv.URL, "http") + "/v1/agents/s1/term"
	c, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": {"http://localhost:5173"}}})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = c.CloseNow() }()

	// First frame is the snapshot.
	_, snap, err := c.Read(ctx)
	if err != nil || string(snap) != "SNAP" {
		t.Fatalf("snapshot: %v %q", err, snap)
	}
	// A subsequent output chunk is streamed to the client.
	fa.termCh <- []byte("more-output")
	_, chunk, err := c.Read(ctx)
	if err != nil || string(chunk) != "more-output" {
		t.Fatalf("stream: %v %q", err, chunk)
	}
}
