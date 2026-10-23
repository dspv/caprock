package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/dspv/caprock/internal/agents"
)

// exitAgents is v2Agents that remembers how sessions ended.
type exitAgents struct {
	*v2Agents
	exits map[string]agents.ExitReport
}

func (a *exitAgents) Exit(id string) (agents.ExitReport, bool) {
	r, ok := a.exits[id]
	return r, ok
}

func exitServer(t *testing.T, exits map[string]agents.ExitReport) (*exitAgents, *httptest.Server) {
	t.Helper()
	e := newEnv(t)
	// No termCh: the daemon holds no session, as after a program exited.
	ag := &exitAgents{v2Agents: &v2Agents{fakeAgents: &fakeAgents{avail: true}}, exits: exits}
	h := New(Deps{Store: e.st, Version: "t", Token: "tok", Now: func() time.Time { return e.now }, Agents: ag})
	e.srv.Config.Handler = h
	return ag, e.srv
}

// A session whose program exited at once is answered with the exit frame,
// early, and a normal close — not refused, which a tab read as "Can't
// connect · next try in 5 s" for good.
func TestTermV2SaysAnEarlyExitInsteadOfRefusing(t *testing.T) {
	_, srv := exitServer(t, map[string]agents.ExitReport{"s1": {SessionID: "s1", Agent: "claude", Code: 1, Early: true, Tail: "No conversation found"}})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c := dialV2(ctx, t, srv, "")
	f, err := readFrame(ctx, c)
	if err != nil {
		t.Fatal(err)
	}
	if raw := string(f.text["exit"]); raw != `{"code":1,"early":1}` {
		t.Fatalf("first frame %+v", f)
	}
	if _, _, err := c.Read(ctx); websocket.CloseStatus(err) != websocket.StatusNormalClosure {
		t.Fatalf("close = %v; want 1000", err)
	}

	// The report itself, for the tab.
	resp, err := srv.Client().Get(srv.URL + "/v1/agents/s1/exit")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	var rep agents.ExitReport
	if resp.StatusCode != http.StatusOK || json.NewDecoder(resp.Body).Decode(&rep) != nil || rep.Tail != "No conversation found" || rep.Code != 1 {
		t.Fatalf("GET exit: %d %+v", resp.StatusCode, rep)
	}
}

// An exit that was not early, and a session with none recorded, are refused
// as before: the tab turns into the conversation with Continue here.
func TestTermV2StillRefusesALateExitOrAnUnknownSession(t *testing.T) {
	for _, exits := range []map[string]agents.ExitReport{
		{"s1": {SessionID: "s1", Code: 0, Early: false}},
		{},
	} {
		_, srv := exitServer(t, exits)
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		if c, err := dialV2Err(ctx, srv, ""); err == nil {
			_ = c.CloseNow()
			t.Fatalf("%v: the socket was accepted", exits)
		}
		cancel()
		resp, err := srv.Client().Get(srv.URL + "/v1/agents/s2/exit")
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusNotFound {
			t.Fatalf("unknown session's exit: %d", resp.StatusCode)
		}
	}
}

// A running session has no exit yet; one whose exit is recorded is
// answered even in the moment the manager still holds it.
func TestAgentExitWhileRunningIs409(t *testing.T) {
	ag, srv := exitServer(t, map[string]agents.ExitReport{"s1": {SessionID: "s1", Code: 1, Early: true}})
	ag.held = map[string]bool{"s1": true, "s2": true}
	for id, want := range map[string]int{"s1": http.StatusOK, "s2": http.StatusConflict} {
		resp, err := srv.Client().Get(srv.URL + "/v1/agents/" + id + "/exit")
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != want {
			t.Fatalf("%s: got %d, want %d", id, resp.StatusCode, want)
		}
	}
}
