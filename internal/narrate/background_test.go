package narrate

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
)

// A turn that ends while a background subagent still works is not waiting on
// anyone: Claude Code resumes the parent by itself when the subagent is done.
// The cockpit read "Waiting on you" beside "1 subagent working" (owner,
// 2026-10-09). A permission dialog still waits, whoever asked.
func TestBackgroundSubagentsAreNotWaitingOnYou(t *testing.T) {
	now := time.Date(2026, 10, 9, 12, 0, 0, 0, time.UTC)
	at := func(s int) time.Time { return now.Add(time.Duration(s-100) * time.Second) }
	stop := event.Event{Kind: event.KindAgentStop, Ts: at(10)}
	subPre := event.Event{Kind: event.KindToolPre, Tool: "Bash", AgentID: "a1", Ts: at(5), Payload: json.RawMessage(`{"tool_input":{"command":"go test ./..."}}`)}
	subLater := event.Event{Kind: event.KindToolPre, Tool: "Read", AgentID: "a1", Ts: at(20), Payload: json.RawMessage(`{"tool_input":{"file_path":"/r/a.go"}}`)}

	cases := []struct {
		name   string
		events []event.Event
		opt    Options
		health string
		phrase string
		bg     int
	}{
		{"stop, no subagent: waiting", []event.Event{stop}, Options{}, HealthWaiting, "waiting for you", 0},
		{"stop last, one subagent working", []event.Event{subPre, stop}, Options{LiveSubagents: 1}, HealthWorking, "background agents working · 1", 1},
		{"subagent event after the stop", []event.Event{stop, subLater}, Options{LiveSubagents: 2}, HealthWorking, "background agents working · 2", 2},
		{"quiet past idle: still background", []event.Event{subPre, stop}, Options{LiveSubagents: 1, Now: now.Add(time.Hour)}, HealthWorking, "background agents working · 1", 1},
		{"main thread mid-turn with a subagent: its own phrase", []event.Event{subPre, {Kind: event.KindToolPre, Tool: "Read", Ts: at(30), Payload: json.RawMessage(`{"tool_input":{"file_path":"/r/b.go"}}`)}}, Options{LiveSubagents: 1}, HealthWorking, "reading b.go", 0},
		{"subagent's permission dialog waits", []event.Event{stop, {Kind: event.KindPermissionPrompt, Tool: "Bash", AgentID: "a1", Ts: at(30)}}, Options{LiveSubagents: 1}, HealthWaiting, "", 0},
		{"main last given by the caller", []event.Event{subPre, subLater}, Options{LiveSubagents: 1, MainLast: &stop}, HealthWorking, "background agents working · 1", 1},
		{"window holds only subagents, caller found no stop", []event.Event{subPre, subLater}, Options{LiveSubagents: 1, MainLast: &event.Event{Kind: event.KindToolPre, Tool: "Agent", Ts: at(1)}}, HealthWorking, "reading a.go", 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if c.opt.Now.IsZero() {
				c.opt.Now = now
			}
			got := Summarize(c.events, c.opt)
			if got.Health != c.health || got.Background != c.bg || (c.phrase != "" && got.Phrase != c.phrase) {
				t.Fatalf("got health=%q phrase=%q background=%d; want %q %q %d", got.Health, got.Phrase, got.Background, c.health, c.phrase, c.bg)
			}
		})
	}
}

// Looping and ended outrank the background state.
func TestBackgroundDoesNotHideLoopingOrEnded(t *testing.T) {
	now := time.Date(2026, 10, 9, 12, 0, 0, 0, time.UTC)
	evs := []event.Event{{Kind: event.KindToolPre, AgentID: "a1", Ts: now.Add(-2 * time.Second)}, {Kind: event.KindAgentStop, Ts: now.Add(-time.Second)}}
	if got := Summarize(evs, Options{Now: now, LiveSubagents: 1, Looping: true}); got.Health != HealthLooping {
		t.Fatalf("looping: %+v", got)
	}
	if got := Summarize(evs, Options{Now: now, LiveSubagents: 1, SessionEnded: true}); got.Health != HealthEnded {
		t.Fatalf("ended: %+v", got)
	}
}
