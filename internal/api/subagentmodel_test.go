package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// subagent_model reaches the spawn untouched when it is on the allowlist and
// is refused otherwise: it becomes an environment variable of the child.
func TestSpawnSubagentModelAllowlist(t *testing.T) {
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
	for _, m := range []string{"haiku", "sonnet", "opus", ""} {
		before := len(fa.spawns)
		if code := post(map[string]any{"cwd": cwd, "subagent_model": m}); code != http.StatusOK {
			t.Fatalf("%q: %d", m, code)
		}
		if got := fa.spawns[before]["subagent_model"]; got != m {
			t.Errorf("%q: spawn saw %v", m, got)
		}
	}
	for _, bad := range []any{"gpt-5", "HAIKU", "haiku\nFOO=1", 3, true} {
		before := len(fa.spawns)
		if code := post(map[string]any{"cwd": cwd, "subagent_model": bad}); code != http.StatusBadRequest {
			t.Errorf("%v: %d, want 400", bad, code)
		}
		if len(fa.spawns) != before {
			t.Errorf("%v: a session was started", bad)
		}
	}
}
