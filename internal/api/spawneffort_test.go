package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// effort reaches the spawn when it is one of the agent's own launch levels
// (or the agent takes none, where it is dropped later), and is refused
// otherwise, without starting anything.
func TestSpawnEffortIsOneOfTheAgentsLevels(t *testing.T) {
	e := newEnv(t)
	fa := &fakeAgents{avail: true}
	e.srv.Config.Handler = New(Deps{Store: e.st, Version: "t", Token: "tok", Settings: e.settings,
		Now: func() time.Time { return e.now }, Agents: fa})
	cwd := t.TempDir()
	post := func(body map[string]any) int {
		t.Helper()
		b, _ := json.Marshal(body)
		req := httptest.NewRequest("POST", "/v1/agents", bytes.NewReader(b))
		req.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		e.srv.Config.Handler.ServeHTTP(rr, req)
		return rr.Code
	}
	for _, ok := range []map[string]any{
		{"effort": "max"}, {"effort": "low"}, {"effort": ""},
		{"agent": "codex", "effort": "xhigh"}, {"agent": "gemini", "effort": "high"},
	} {
		before := len(fa.spawns)
		ok["cwd"] = cwd
		if code := post(ok); code != http.StatusOK {
			t.Fatalf("%v: %d", ok, code)
		}
		if got := fa.spawns[before]["effort"]; got != ok["effort"] {
			t.Errorf("%v: spawn saw %v", ok, got)
		}
	}
	for _, bad := range []map[string]any{
		{"effort": "ultracode"}, {"effort": "High"}, {"effort": 3},
		{"agent": "codex", "effort": "max"}, {"agent": "claude", "effort": "minimal"},
	} {
		before := len(fa.spawns)
		bad["cwd"] = cwd
		if code := post(bad); code != http.StatusBadRequest {
			t.Errorf("%v: %d, want 400", bad, code)
		}
		if len(fa.spawns) != before {
			t.Errorf("%v: a session was started", bad)
		}
	}
}
