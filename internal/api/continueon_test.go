package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/pairing"
)

// continuingAgents is fakeAgents that also continues sessions elsewhere.
type continuingAgents struct {
	fakeAgents
	asked []string
	err   error
}

func (c *continuingAgents) ContinueOn(_ context.Context, id, target string) (ContinueOnResult, error) {
	c.asked = append(c.asked, id+"→"+target)
	if c.err != nil {
		return ContinueOnResult{}, c.err
	}
	return ContinueOnResult{SessionID: "new", ContinuedFrom: id, Target: target, From: "default", How: "resume", SameConversation: true}, nil
}

func TestContinueOnEndpoint(t *testing.T) {
	e := newEnv(t)
	ca := &continuingAgents{fakeAgents: fakeAgents{avail: true}}
	h := New(Deps{Store: e.st, Version: "t", Token: "tok", Now: func() time.Time { return e.now }, Agents: ca})
	do := func(body string, dev *pairing.Device) (int, string) {
		req := httptest.NewRequest("POST", "/v1/sessions/s1/continue-on", bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
		if dev != nil {
			req = req.WithContext(context.WithValue(req.Context(), deviceKey{}, dev))
		}
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		b, _ := io.ReadAll(rr.Result().Body)
		return rr.Code, string(b)
	}
	code, body := do(`{"target":"kimi"}`, nil)
	var res ContinueOnResult
	if code != 200 || json.Unmarshal([]byte(body), &res) != nil || res.SessionID != "new" || res.ContinuedFrom != "s1" || res.Target != "kimi" {
		t.Fatalf("continue: %d %s", code, body)
	}
	if code, _ := do(`{}`, nil); code != 400 {
		t.Fatalf("no target: %d", code)
	}
	// A paired device is refused before anything is asked of the daemon,
	// a phone and an allowed computer alike.
	n := len(ca.asked)
	for _, kind := range []string{pairing.KindPhone, pairing.KindMachine} {
		if code, _ := do(`{"target":"kimi"}`, &pairing.Device{ID: "d", Kind: kind}); code != http.StatusForbidden {
			t.Fatalf("from a %s device: %d", kind, code)
		}
	}
	if len(ca.asked) != n {
		t.Fatal("a device's request reached the daemon")
	}
	for err, want := range map[error]int{
		ErrContinueNotOwned:                 http.StatusConflict,
		ErrContinueNotFound:                 http.StatusNotFound,
		ContinueRefusal{Msg: "no Kimi key"}: http.StatusBadRequest,
	} {
		ca.err = err
		if code, body := do(`{"target":"kimi"}`, nil); code != want || !strings.Contains(body, err.Error()) {
			t.Fatalf("%v: %d %s", err, code, body)
		}
	}
	// Without a continuer: not implemented, not a crash.
	plain := New(Deps{Store: e.st, Version: "t", Token: "tok", Agents: &fakeAgents{avail: true}})
	req := httptest.NewRequest("POST", "/v1/sessions/s1/continue-on", bytes.NewBufferString(`{"target":"kimi"}`))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	plain.ServeHTTP(rr, req)
	if rr.Code != http.StatusNotImplemented {
		t.Fatalf("no continuer: %d", rr.Code)
	}
}

// The Kimi key is write-only, as the DeepSeek key is; the limit settings
// round-trip and refuse nonsense.
func TestSettingsKimiKeyAndLimitAction(t *testing.T) {
	e := newEnv(t)
	key := "sk-kimi-" + "test-only-0000"
	if code := e.putSettings(t, map[string]any{"kimi_api_key": key, "limit_action": "auto",
		"limit_fallbacks": []string{"deepseek", "kimi", "deepseek", "0a1b2c3d"}, "limit_return_after_reset": true}); code != 200 {
		t.Fatalf("PUT: %d", code)
	}
	if e.settings.cur.KimiAPIKey != key {
		t.Fatal("the key did not reach the daemon")
	}
	resp, err := http.Get(e.srv.URL + "/v1/settings")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if strings.Contains(string(b), key) {
		t.Fatal("GET returned the key")
	}
	var got Settings
	_ = json.Unmarshal(b, &got)
	if got.LimitAction != "auto" || !got.LimitReturn || strings.Join(got.LimitFallbacks, ",") != "deepseek,kimi,0a1b2c3d" {
		t.Fatalf("limit settings: %q %v %v", got.LimitAction, got.LimitFallbacks, got.LimitReturn)
	}
	for _, bad := range []map[string]any{
		{"limit_action": "sometimes"},
		{"limit_fallbacks": []string{"../etc"}},
		{"kimi_api_key": "a\nb"},
	} {
		if code := e.putSettings(t, bad); code != 400 {
			t.Fatalf("%v: %d", bad, code)
		}
	}
}
