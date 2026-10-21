package narrate

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
)

// Input typed into a session that has not written an event for it yet moves
// the status at once (owner, 2026-10-14: "waiting for you" 10-20 s after he
// had set the agent going), and the next event always wins.
func TestANudgeMovesTheStatusUntilTheNextEvent(t *testing.T) {
	now := time.Date(2026, 10, 14, 12, 0, 0, 0, time.UTC)
	at := now.Add(-time.Second)
	prompt := event.Event{Ts: at.Add(-time.Minute), Kind: event.KindPermissionPrompt, Tool: "Bash",
		Payload: json.RawMessage(`{"tool_name":"Bash","tool_input":{"command":"go test ./..."}}`)}
	question := event.Event{Ts: at.Add(-time.Minute), Kind: event.KindPermissionPrompt, Tool: "AskUserQuestion"}
	stop := event.Event{Ts: at.Add(-time.Minute), Kind: event.KindAgentStop, Payload: json.RawMessage(`{"last_assistant_message":"Merge it?"}`)}
	cleared := event.Event{Ts: at.Add(-time.Minute), Kind: event.KindContextClear}
	toolPre := event.Event{Ts: at.Add(-time.Minute), Kind: event.KindToolPre, Tool: "Read"}
	for _, tc := range []struct {
		name        string
		last        event.Event
		nudge       *Nudge
		now         time.Time
		health      string
		phrase      string
		provisional bool
	}{
		{"approved runs the call", prompt, &Nudge{At: at, Kind: NudgeApproved}, now, HealthWorking, "approved — running `go test ./...`", false},
		{"rejected returns to the prompt", prompt, &Nudge{At: at, Kind: NudgeRejected}, now, HealthWaiting, "waiting for you", false},
		{"an approval long ago is idle", prompt, &Nudge{At: at, Kind: NudgeApproved}, at.Add(10 * time.Minute), HealthIdle, "was approved — running `go test ./...`", false},
		{"enter after the turn ended", stop, &Nudge{At: at, Kind: NudgeSubmit}, now, HealthWorking, "starting on your message", true},
		{"enter after /clear", cleared, &Nudge{At: at, Kind: NudgeSubmit}, now, HealthWorking, "starting on your message", true},
		{"enter answered by nothing goes back", stop, &Nudge{At: at, Kind: NudgeSubmit}, at.Add(NudgeWindow), HealthWaiting, "waiting for you", false},
		{"enter at a dialog is not a message", prompt, &Nudge{At: at, Kind: NudgeSubmit}, now, HealthWaiting, "waiting for approval — running `go test ./...`", false},
		{"enter while working changes nothing", toolPre, &Nudge{At: at, Kind: NudgeSubmit}, now, HealthWorking, "reading a file", false},
		{"a question is answered by its own call", question, &Nudge{At: at, Kind: NudgeApproved}, now, HealthWaiting, "waiting for your answer", false},
		{"an approval does not outlive its dialog", stop, &Nudge{At: at, Kind: NudgeApproved}, now, HealthWaiting, "waiting for you", false},
		{"an event after the nudge wins", stop, &Nudge{At: stop.Ts.Add(-time.Second), Kind: NudgeSubmit}, now, HealthWaiting, "waiting for you", false},
		{"no nudge", stop, nil, now, HealthWaiting, "waiting for you", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			act := Summarize([]event.Event{tc.last}, Options{Now: tc.now, Nudge: tc.nudge})
			if act.Health != tc.health || act.Phrase != tc.phrase || act.Provisional != tc.provisional {
				t.Fatalf("got %s %q provisional=%v; want %s %q provisional=%v", act.Health, act.Phrase, act.Provisional, tc.health, tc.phrase, tc.provisional)
			}
		})
	}
}

// A looping or ended session says so whatever was typed into it.
func TestANudgeDoesNotHideALoopOrAnEnd(t *testing.T) {
	now := time.Now()
	stop := event.Event{Ts: now.Add(-time.Minute), Kind: event.KindAgentStop}
	n := &Nudge{At: now.Add(-time.Second), Kind: NudgeSubmit}
	if act := Summarize([]event.Event{stop}, Options{Now: now, Nudge: n, Looping: true}); act.Health != HealthLooping {
		t.Fatalf("looping: %s", act.Health)
	}
	if act := Summarize([]event.Event{stop}, Options{Now: now, Nudge: n, SessionEnded: true}); act.Health != HealthEnded {
		t.Fatalf("ended: %s", act.Health)
	}
}
