package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// The effort a session's hooks name reaches the session list and the session
// itself as `effort`, the newest known level winning; a level Caprock does
// not know is never shown.
func TestHookEffortReachesTheSession(t *testing.T) {
	e := newEnv(t)
	hook := func(body string) {
		t.Helper()
		req, _ := http.NewRequest(http.MethodPost, e.srv.URL+"/v1/hook", strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer tok")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != 204 {
			t.Fatalf("hook: %d", resp.StatusCode)
		}
	}
	effort := func() string {
		t.Helper()
		var one map[string]json.RawMessage
		e.get(t, "/v1/sessions/thinker", &one)
		var list []SessionSummary
		e.get(t, "/v1/sessions", &list)
		if len(list) != 1 {
			t.Fatalf("sessions: %+v", list)
		}
		var got string
		if raw, ok := one["effort"]; ok {
			_ = json.Unmarshal(raw, &got)
		}
		if got != list[0].Effort {
			t.Fatalf("detail says %q, list says %q", got, list[0].Effort)
		}
		return got
	}
	hook(`{"session_id":"thinker","hook_event_name":"UserPromptSubmit","prompt_id":"p1","prompt":"hi","cwd":"/p"}`)
	if got := effort(); got != "" {
		t.Fatalf("no effort named, got %q", got)
	}
	hook(`{"session_id":"thinker","hook_event_name":"UserPromptSubmit","prompt_id":"p2","prompt":"hi","cwd":"/p","effort":{"level":"high"}}`)
	if got := effort(); got != "high" {
		t.Fatalf("effort %q, want high", got)
	}
	hook(`{"session_id":"thinker","hook_event_name":"UserPromptSubmit","prompt_id":"p3","prompt":"hi","cwd":"/p","effort":{"level":"<b>huge</b>"}}`)
	if got := effort(); got != "high" {
		t.Fatalf("an unknown level replaced it: %q", got)
	}
	hook(`{"session_id":"thinker","hook_event_name":"UserPromptSubmit","prompt_id":"p4","prompt":"hi","cwd":"/p","effort":{"level":"max"}}`)
	if got := effort(); got != "max" {
		t.Fatalf("effort %q, want max", got)
	}
}
