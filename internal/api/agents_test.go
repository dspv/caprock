package api

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

type fakeAgents struct {
	avail  bool
	inputs []string
	sigs   []string
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
	return nil, nil, nil, false
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
