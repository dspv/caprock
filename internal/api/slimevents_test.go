package api

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/dspv/caprock/internal/event"
)

func hookPost(t *testing.T, e *env, body string) {
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

// slim=1 sends a tool.post without its body, keeping what the inspector
// reads of it: an error's head, interrupted, the other fields. Without it,
// the body is there.
func TestSessionEventsSlim(t *testing.T) {
	e := newEnv(t)
	big := strings.Repeat("output line\n", 2000)
	hookPost(t, e, `{"session_id":"s1","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"make"},"tool_use_id":"t1","cwd":"/p"}`)
	hookPost(t, e, `{"session_id":"s1","hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"make"},"tool_response":{"stdout":`+jsonString(big)+`,"interrupted":true},"tool_use_id":"t1","cwd":"/p"}`)
	read := func(q string) ([]event.Event, int) {
		t.Helper()
		resp, err := http.Get(e.srv.URL + "/v1/sessions/s1/events?newest=1&main=1&kind=tool.pre,tool.post&limit=400" + q)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		var evs []event.Event
		if err := json.Unmarshal(b, &evs); err != nil {
			t.Fatalf("%s: %v", b, err)
		}
		return evs, len(b)
	}
	full, fullBytes := read("")
	slim, slimBytes := read("&slim=1")
	if len(full) != 2 || len(slim) != 2 {
		t.Fatalf("events: %d full, %d slim", len(full), len(slim))
	}
	if slimBytes*4 > fullBytes {
		t.Fatalf("slim is %d bytes against %d", slimBytes, fullBytes)
	}
	for i := range slim {
		if slim[i].Kind == event.KindToolPre {
			if string(slim[i].Payload) != string(full[i].Payload) {
				t.Fatalf("a tool.pre changed: %s", slim[i].Payload)
			}
			continue
		}
		var p map[string]any
		_ = json.Unmarshal(slim[i].Payload, &p)
		if _, ok := p["tool_response"]; ok {
			t.Fatalf("a slim tool.post kept its body: %v", p)
		}
		if _, ok := p["tool_input"]; ok {
			t.Fatalf("a slim tool.post kept its input: %v", p)
		}
		if p["interrupted"] != true || p["tool_name"] != "Bash" {
			t.Fatalf("a slim tool.post lost what is read of it: %v", p)
		}
	}
}

// An erroring result keeps the head of its text, where its exit code is.
func TestSlimToolPostKeepsAnErrorsHead(t *testing.T) {
	long := "Exit code 2\n" + strings.Repeat("é", 500)
	for _, resp := range []string{
		jsonString(long),
		`[{"type":"text","text":` + jsonString(long) + `}]`,
		`{"content":` + jsonString(long) + `}`,
	} {
		e := event.Event{Kind: event.KindToolPost, Payload: json.RawMessage(`{"is_error":true,"tool_response":` + resp + `,"exit_code":2}`)}
		var p map[string]any
		if err := json.Unmarshal(slimToolPost(e).Payload, &p); err != nil {
			t.Fatal(err)
		}
		head, _ := p["tool_response"].(string)
		if !strings.HasPrefix(head, "Exit code 2") || len([]rune(head)) != slimResultHead || p["exit_code"] != float64(2) {
			t.Fatalf("%s: %v", resp, p)
		}
	}
	other := event.Event{Kind: event.KindTurnAssistant, Payload: json.RawMessage(`{"tool_response":"x"}`)}
	if string(slimToolPost(other).Payload) != `{"tool_response":"x"}` {
		t.Fatal("another kind was changed")
	}
}
