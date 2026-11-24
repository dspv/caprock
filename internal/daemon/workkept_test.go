package daemon

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/narrate"
	"github.com/dspv/caprock/internal/store"
)

// What the Work board keeps of its events reads as the whole events do:
// every state the narration and the hook reading give, at every point of a
// session that writes, edits, plans, runs, fails and is stopped. And it is
// much smaller.
func TestWorkEventsKeptReadTheSame(t *testing.T) {
	t0 := time.Date(2026, 11, 24, 9, 0, 0, 0, time.UTC)
	big := strings.Repeat("line of a file\n", 4000)
	ev := func(i int, src event.Source, kind event.Kind, tool, payload string) event.Event {
		return event.Event{ID: int64(i + 1), Ts: t0.Add(time.Duration(i) * 20 * time.Second), SessionID: "s", Source: src, Kind: kind, Tool: tool, Payload: json.RawMessage(payload)}
	}
	js := func(s string) string { b, _ := json.Marshal(s); return string(b) }
	h, tr := event.SourceHook, event.SourceTranscript
	evs := []event.Event{
		ev(0, h, event.KindAgentSpawn, "", `{"source":"startup","cwd":"/w"}`),
		ev(1, h, event.KindTurnUser, "", `{"prompt":"fix it"}`),
		ev(2, h, event.KindToolPre, "TodoWrite", `{"tool_input":{"todos":[{"content":"a","status":"completed","activeForm":"A"},{"content":"b","status":"in_progress","activeForm":"Doing b"}]}}`),
		ev(3, h, event.KindToolPre, "Write", `{"tool_input":{"file_path":"/w/x.go","content":`+js(big)+`}}`),
		ev(4, h, event.KindToolPost, "Write", `{"tool_input":{"file_path":"/w/x.go","content":`+js(big)+`},"tool_response":{"filePath":"/w/x.go","content":`+js(big)+`}}`),
		ev(5, h, event.KindToolPre, "Edit", `{"tool_input":{"file_path":"/w/y.go","old_string":`+js(big)+`,"new_string":`+js(big)+`}}`),
		ev(6, h, event.KindToolPost, "Edit", `{"tool_input":{"file_path":"/w/y.go","old_string":"a","new_string":"b"},"tool_response":{"originalFile":`+js(big)+`}}`),
		ev(7, h, event.KindToolPre, "Bash", `{"tool_input":{"command":"go test ./...","description":"Run the tests"}}`),
		ev(8, h, event.KindToolPost, "Bash", `{"tool_input":{"command":"go test ./..."},"tool_response":{"stdout":`+js(big)+`,"stderr":"","interrupted":false,"is_error":true}}`),
		ev(9, tr, event.KindToolPost, "Bash", `{"is_error":true,"tool_response":"Exit code 1\n`+strings.Repeat("x", 3000)+`"}`),
		ev(10, h, event.KindToolPre, "Grep", `{"tool_input":{"pattern":"func main"}}`),
		ev(11, h, event.KindToolPost, "Grep", `{"tool_input":{"pattern":"func main"},"tool_response":{"error":"bad regex"}}`),
		ev(12, h, event.KindContextCompact, "", `{"trigger":"auto"}`),
		ev(13, h, event.KindPermissionPrompt, "Bash", `{"tool_input":{"command":"rm -rf build"}}`),
		ev(14, h, event.KindAgentStop, "", `{"last_assistant_message":"Done. Shall I push?"}`),
	}
	whole, kept := 0, 0
	for _, e := range evs {
		whole += len(e.Payload)
	}
	for _, e := range stateKept(evs) {
		kept += len(e.Payload)
	}
	if kept*10 > whole {
		t.Fatalf("kept %d bytes of %d", kept, whole)
	}
	for end := 1; end <= len(evs); end++ {
		part := evs[:end]
		for _, now := range []time.Time{part[end-1].Ts.Add(time.Second), part[end-1].Ts.Add(10 * time.Minute)} {
			opt := narrate.Options{Now: now, IdleAfter: 5 * time.Minute}
			a, b := narrate.Summarize(part, opt), narrate.Summarize(stateKept(part), opt)
			if a.Health != b.Health || a.Phrase != b.Phrase {
				t.Fatalf("after %d events: whole %q %q, kept %q %q", end, a.Health, a.Phrase, b.Health, b.Phrase)
			}
		}
		w1, h1 := handWaiting(part)
		w2, h2 := handWaiting(turnsKept(part))
		if w1 != w2 || h1 != h2 {
			t.Fatalf("after %d events: whole %q %v, kept %q %v", end, w1, h1, w2, h2)
		}
	}
	// A compaction asked for by hand and a start after one read the same.
	for _, p := range []string{`{"trigger":"manual"}`, `{"source":"compact"}`} {
		k := event.KindContextCompact
		if strings.Contains(p, "source") {
			k = event.KindAgentSpawn
		}
		part := []event.Event{ev(0, h, event.KindTurnUser, "", `{}`), ev(1, h, k, "", p)}
		w1, h1 := handWaiting(part)
		w2, h2 := handWaiting(turnsKept(part))
		if w1 != w2 || h1 != h2 {
			t.Fatalf("%s: whole %q %v, kept %q %v", p, w1, h1, w2, h2)
		}
	}
}

// An entry the last board read did not use is dropped at the next one.
func TestWorkEventsDropSessionsNoLongerRead(t *testing.T) {
	var c workEvents
	c.sweep()
	c.entry("a", store.EventsGen{Gen: 1})
	c.entry("b", store.EventsGen{Gen: 1})
	c.sweep()
	c.entry("a", store.EventsGen{Gen: 1})
	c.sweep()
	if _, ok := c.m["b"]; ok {
		t.Fatal("a session the last read did not use was kept")
	}
	if _, ok := c.m["a"]; !ok {
		t.Fatal("a session the last read used was dropped")
	}
}
