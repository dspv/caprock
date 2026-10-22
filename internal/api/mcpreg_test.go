package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/dspv/caprock/internal/mcpreg"
	"github.com/dspv/caprock/internal/pairing"
)

type fakeMCP struct {
	calls []string
	err   error
}

func (f *fakeMCP) Statuses() []mcpreg.Status {
	return []mcpreg.Status{{Agent: "claude", Name: "Claude Code", State: mcpreg.NotConnected}}
}
func (f *fakeMCP) Executable() (string, error) { return "/opt/homebrew/bin/caprock", nil }
func (f *fakeMCP) Connect(_ context.Context, a string) (mcpreg.Status, error) {
	f.calls = append(f.calls, "connect "+a)
	return mcpreg.Status{Agent: a, State: mcpreg.Connected}, f.err
}
func (f *fakeMCP) Disconnect(_ context.Context, a string) (mcpreg.Status, error) {
	f.calls = append(f.calls, "disconnect "+a)
	return mcpreg.Status{Agent: a, State: mcpreg.NotConnected}, f.err
}

func mcpPost(e *env, path, agent string, dev *pairing.Device, connect bool) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodPost, path, nil)
	r.SetPathValue("agent", agent)
	if dev != nil {
		r = r.WithContext(context.WithValue(r.Context(), deviceKey{}, dev))
	}
	w := httptest.NewRecorder()
	if connect {
		e.api.handleMCPConnect(w, r)
	} else {
		e.api.handleMCPDisconnect(w, r)
	}
	return w
}

func TestMCPAgentsStatus(t *testing.T) {
	e := newEnv(t)
	var none map[string]any
	if code := e.get(t, "/v1/mcp/agents", &none); code != http.StatusNotImplemented {
		t.Fatalf("no registrar: %d", code)
	}
	e.api.d.MCP = &fakeMCP{}
	var got mcpAgentsBody
	if code := e.get(t, "/v1/mcp/agents", &got); code != 200 || got.Executable != "/opt/homebrew/bin/caprock" || len(got.Agents) != 1 || got.Agents[0].State != mcpreg.NotConnected {
		t.Fatalf("%d %+v", code, got)
	}
}

func TestMCPConnectOnTheMachineOnly(t *testing.T) {
	e := newEnv(t)
	f := &fakeMCP{}
	e.api.d.MCP = f
	for _, dev := range []*pairing.Device{
		{Kind: pairing.KindPhone, Role: pairing.RoleController},
		{Kind: pairing.KindMachine, Role: pairing.RoleController},
	} {
		if w := mcpPost(e, "/v1/mcp/agents/claude/connect", "claude", dev, true); w.Code != http.StatusForbidden {
			t.Errorf("%+v connect: %d, want 403", dev, w.Code)
		}
		if w := mcpPost(e, "/v1/mcp/agents/claude/disconnect", "claude", dev, false); w.Code != http.StatusForbidden {
			t.Errorf("%+v disconnect: %d, want 403", dev, w.Code)
		}
	}
	if len(f.calls) != 0 {
		t.Fatalf("a paired device reached the registrar: %v", f.calls)
	}
	w := mcpPost(e, "/v1/mcp/agents/codex/connect", "codex", nil, true)
	var st mcpreg.Status
	_ = json.NewDecoder(w.Body).Decode(&st)
	if w.Code != 200 || st.State != mcpreg.Connected {
		t.Fatalf("machine connect: %d %+v", w.Code, st)
	}
	if w := mcpPost(e, "/v1/mcp/agents/codex/disconnect", "codex", nil, false); w.Code != 200 {
		t.Fatalf("machine disconnect: %d", w.Code)
	}
	if len(f.calls) != 2 || f.calls[0] != "connect codex" || f.calls[1] != "disconnect codex" {
		t.Fatalf("calls = %v", f.calls)
	}
}

func TestMCPConnectShowsTheCLIsMessage(t *testing.T) {
	e := newEnv(t)
	e.api.d.MCP = &fakeMCP{err: &mcpreg.CLIError{Agent: "claude", Output: "Error: MCP server caprock already exists in user config"}}
	w := mcpPost(e, "/v1/mcp/agents/claude/connect", "claude", nil, true)
	var body struct{ Error string }
	_ = json.NewDecoder(w.Body).Decode(&body)
	if w.Code != http.StatusBadGateway || body.Error != "Claude Code: Error: MCP server caprock already exists in user config" {
		t.Fatalf("%d %q", w.Code, body.Error)
	}
	e.api.d.MCP = &fakeMCP{err: mcpreg.ErrUnknownAgent}
	if w := mcpPost(e, "/v1/mcp/agents/gemini/connect", "gemini", nil, true); w.Code != http.StatusNotFound {
		t.Fatalf("unknown agent: %d", w.Code)
	}
}
