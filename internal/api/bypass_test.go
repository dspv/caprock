package api

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// A bypass start on a machine that never accepted Claude Code's bypass
// warning would open on that warning, with "No, exit" selected (ADR-041):
// the daemon refuses it with a code the dialogs turn into the consent screen.
func TestBypassStartNeedsConsent(t *testing.T) {
	e := newEnv(t)
	fa := &fakeAgents{avail: true}
	accepted := false
	e.srv.Config.Handler = New(Deps{Store: e.st, Version: "t", Token: "tok", Now: func() time.Time { return e.now }, Agents: fa,
		BypassAccepted: func() (bool, error) { return accepted, nil },
		AcceptBypass:   func() error { accepted = true; return nil },
	})
	do := func(path, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("POST", path, bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		e.srv.Config.Handler.ServeHTTP(rr, req)
		return rr
	}
	r := do("/v1/agents", `{"cwd":"/tmp/x","permission_mode":"bypassPermissions"}`)
	if r.Code != http.StatusConflict || !bytes.Contains(r.Body.Bytes(), []byte(`"code":"bypass_consent"`)) {
		t.Fatalf("bypass without consent: %d %s", r.Code, r.Body)
	}
	// Another mode, another agent and a terminal command never need it.
	for _, body := range []string{
		`{"cwd":"/tmp/x","permission_mode":"acceptEdits"}`,
		`{"cwd":"/tmp/x","agent":"codex","permission_mode":"bypassPermissions"}`,
		`{"cwd":"/tmp/x","command":"zsh","permission_mode":"bypassPermissions"}`,
	} {
		if r := do("/v1/agents", body); r.Code != http.StatusOK {
			t.Fatalf("%s: %d %s", body, r.Code, r.Body)
		}
	}
	if r := do("/v1/claude/bypass-consent", `{}`); r.Code != http.StatusOK || !accepted {
		t.Fatalf("consent: %d %s", r.Code, r.Body)
	}
	if r := do("/v1/agents", `{"cwd":"/tmp/x","permission_mode":"bypassPermissions"}`); r.Code != http.StatusOK {
		t.Fatalf("bypass after consent: %d %s", r.Code, r.Body)
	}
}

func TestBypassConsentNotWiredIs501(t *testing.T) {
	e := newEnv(t)
	e.srv.Config.Handler = New(Deps{Store: e.st, Version: "t", Token: "tok", Now: func() time.Time { return e.now }, Agents: &fakeAgents{avail: true}})
	req := httptest.NewRequest("POST", "/v1/claude/bypass-consent", bytes.NewBufferString(`{}`))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	e.srv.Config.Handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusNotImplemented {
		t.Fatalf("got %d", rr.Code)
	}
}
