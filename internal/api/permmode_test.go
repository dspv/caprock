package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/store"
)

// modeAgents is fakeAgents with a permission-mode switch: "mine" is held,
// anything else is not.
type modeAgents struct {
	fakeAgents
	set []string
	err error
}

func (f *modeAgents) PermissionMode(_ context.Context, id string) (PermissionModeView, bool) {
	if id != "mine" {
		return PermissionModeView{}, false
	}
	return PermissionModeView{SessionID: id, Mode: "acceptEdits", Source: "screen", Switchable: true,
		InSession: []string{"default", "acceptEdits", "plan", "auto"}, Restart: []string{"bypassPermissions", "dontAsk"}}, true
}

func (f *modeAgents) SetPermissionMode(_ context.Context, id, mode string, restart bool) (PermissionModeView, error) {
	if restart {
		mode += "+restart"
	}
	f.set = append(f.set, id+":"+mode)
	if f.err != nil {
		return PermissionModeView{}, f.err
	}
	return PermissionModeView{SessionID: id, Mode: mode, Switchable: true}, nil
}

func TestPermissionModeEndpoints(t *testing.T) {
	e := newEnv(t)
	fa := &modeAgents{fakeAgents: fakeAgents{avail: true}}
	e.srv.Config.Handler = New(Deps{Store: e.st, Version: "t", Token: "tok", Now: func() time.Time { return e.now }, Agents: fa})
	do := func(method, path, body string) (*httptest.ResponseRecorder, map[string]any) {
		req := httptest.NewRequest(method, path, bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		e.srv.Config.Handler.ServeHTTP(rr, req)
		var out map[string]any
		_ = json.Unmarshal(rr.Body.Bytes(), &out)
		return rr, out
	}

	// A session Caprock started: the manager's answer, switchable.
	if r, out := do("GET", "/v1/sessions/mine/permission-mode", ""); r.Code != 200 || out["mode"] != "acceptEdits" || out["switchable"] != true {
		t.Fatalf("owned: %d %v", r.Code, out)
	}

	// One started elsewhere: what its hooks last said, read-only.
	ev := event.Event{SessionID: "theirs", Source: event.SourceHook, Kind: event.KindTurnUser, Ts: e.now, Payload: json.RawMessage(`{"permission_mode":"plan"}`)}
	if _, err := store.InsertEvent(context.Background(), e.st.DB(), &ev); err != nil {
		t.Fatal(err)
	}
	if r, out := do("GET", "/v1/sessions/theirs/permission-mode", ""); r.Code != 200 || out["mode"] != "plan" || out["source"] != "hook" || out["switchable"] != false {
		t.Fatalf("not owned: %d %v", r.Code, out)
	}
	if r, out := do("GET", "/v1/sessions/unknown/permission-mode", ""); r.Code != 200 || out["mode"] != "" {
		t.Fatalf("nothing known: %d %v", r.Code, out)
	}

	// A switch, and a restart.
	if r, out := do("POST", "/v1/agents/mine/permission-mode", `{"mode":"plan"}`); r.Code != 200 || out["mode"] != "plan" {
		t.Fatalf("switch: %d %v", r.Code, out)
	}
	if r, _ := do("POST", "/v1/agents/mine/permission-mode", `{"mode":"bypassPermissions","restart":true}`); r.Code != 200 {
		t.Fatalf("restart: %d", r.Code)
	}
	// "manual" is the command line's word for default.
	if r, _ := do("POST", "/v1/agents/mine/permission-mode", `{"mode":"manual"}`); r.Code != 200 {
		t.Fatalf("manual: %d", r.Code)
	}
	for _, body := range []string{`{"mode":"yolo"}`, `{}`, `not json`} {
		if r, _ := do("POST", "/v1/agents/mine/permission-mode", body); r.Code != http.StatusBadRequest {
			t.Fatalf("%s: %d", body, r.Code)
		}
	}
	if len(fa.set) != 3 || fa.set[1] != "mine:bypassPermissions+restart" {
		t.Fatalf("switches made: %v", fa.set)
	}

	// A refusal keeps its status, code and the mode the session is in.
	fa.err = &ModeError{Status: http.StatusConflict, Code: "bypass_consent", Msg: "consent first", Mode: "acceptEdits"}
	r, out := do("POST", "/v1/agents/mine/permission-mode", `{"mode":"bypassPermissions","restart":true}`)
	if r.Code != http.StatusConflict || out["code"] != "bypass_consent" || out["mode"] != "acceptEdits" {
		t.Fatalf("refusal: %d %v", r.Code, out)
	}
}

// Without a switcher the daemon says so rather than pretending.
func TestPermissionModeWithoutASwitcher(t *testing.T) {
	e := newEnv(t)
	e.srv.Config.Handler = New(Deps{Store: e.st, Version: "t", Token: "tok", Agents: &fakeAgents{avail: true}})
	req := httptest.NewRequest("POST", "/v1/agents/x/permission-mode", bytes.NewBufferString(`{"mode":"plan"}`))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	e.srv.Config.Handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusNotImplemented {
		t.Fatalf("got %d", rr.Code)
	}
}
