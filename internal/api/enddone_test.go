package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// end_when_done reaches the spawn for a new Claude Code or Codex session with
// a prompt, and is refused, with nothing started, everywhere it could not
// work: no prompt, a continued session, another agent, a command, a
// non-boolean.
func TestSpawnEndWhenDone(t *testing.T) {
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
		{"cwd": cwd, "prompt": "do the job", "end_when_done": true},
		{"cwd": cwd, "agent": "claude", "prompt": "do the job", "end_when_done": true},
		{"cwd": cwd, "agent": "codex", "prompt": "do the job", "end_when_done": true},
		{"cwd": cwd, "end_when_done": false},
	} {
		before := len(fa.spawns)
		if code := post(ok); code != http.StatusOK {
			t.Fatalf("%v: %d", ok, code)
		}
		if got := fa.spawns[before]["end_when_done"]; got != ok["end_when_done"] {
			t.Errorf("%v: spawn saw end_when_done %v", ok, got)
		}
	}
	for _, bad := range []map[string]any{
		{"cwd": cwd, "end_when_done": true},
		{"cwd": cwd, "prompt": "  ", "end_when_done": true},
		{"cwd": cwd, "prompt": "x", "resume": "s-old", "end_when_done": true},
		{"cwd": cwd, "prompt": "x", "agent": "gemini", "end_when_done": true},
		{"cwd": cwd, "prompt": "x", "agent": "custom:mine", "end_when_done": true},
		{"cwd": cwd, "prompt": "x", "command": "bash", "end_when_done": true},
		{"cwd": cwd, "prompt": "x", "end_when_done": "yes"},
		{"cwd": cwd, "prompt": "x", "end_when_done": 1},
	} {
		before := len(fa.spawns)
		if code := post(bad); code != http.StatusBadRequest {
			t.Errorf("%v: %d, want 400", bad, code)
		}
		if len(fa.spawns) != before {
			t.Errorf("%v: a session was started", bad)
		}
	}
}
