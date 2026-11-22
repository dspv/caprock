package narrate

import (
	"encoding/json"
	"testing"

	"github.com/dspv/caprock/internal/event"
)

func TestTurnOpen(t *testing.T) {
	hook := func(k event.Kind, payload string) event.Event {
		e := event.Event{Kind: k, Source: event.SourceHook}
		if payload != "" {
			e.Payload = json.RawMessage(payload)
		}
		return e
	}
	tr := func(k event.Kind) event.Event { return event.Event{Kind: k, Source: event.SourceTranscript} }
	sub := func(k event.Kind) event.Event {
		e := hook(k, "")
		e.AgentID = "a1"
		return e
	}
	cases := []struct {
		name string
		evs  []event.Event
		want bool
	}{
		{"nothing", nil, false},
		{"a prompt with no Stop", []event.Event{hook(event.KindAgentStop, ""), hook(event.KindTurnUser, `{"prompt":"fix it"}`)}, true},
		{"a call running is work, not a stall", []event.Event{hook(event.KindTurnUser, ""), hook(event.KindToolPre, `{"tool_use_id":"t1"}`)}, false},
		{"a call with no id is taken as running", []event.Event{hook(event.KindTurnUser, ""), hook(event.KindToolPre, "")}, false},
		{"a call done, no reply yet", []event.Event{hook(event.KindTurnUser, ""), hook(event.KindToolPre, `{"tool_use_id":"t1"}`), hook(event.KindToolPost, `{"tool_use_id":"t1"}`)}, true},
		{"one of two parallel calls still running", []event.Event{hook(event.KindTurnUser, ""), hook(event.KindToolPre, `{"tool_use_id":"a"}`), hook(event.KindToolPre, `{"tool_use_id":"b"}`), hook(event.KindToolPost, `{"tool_use_id":"b"}`)}, false},
		{"both parallel calls done", []event.Event{hook(event.KindTurnUser, ""), hook(event.KindToolPre, `{"tool_use_id":"a"}`), hook(event.KindToolPre, `{"tool_use_id":"b"}`), hook(event.KindToolPost, `{"tool_use_id":"b"}`), hook(event.KindToolPost, `{"tool_use_id":"a"}`)}, true},
		{"a subagent's running call does not hold the main thread", []event.Event{hook(event.KindTurnUser, ""), sub(event.KindToolPre)}, true},
		{"the prompt older than the window, its calls done", []event.Event{hook(event.KindToolPre, `{"tool_use_id":"t1"}`), hook(event.KindToolPost, `{"tool_use_id":"t1"}`)}, true},
		{"the turn ended", []event.Event{hook(event.KindTurnUser, ""), hook(event.KindAgentStop, "")}, false},
		{"a transcript reply after the Stop changes nothing", []event.Event{hook(event.KindTurnUser, ""), hook(event.KindAgentStop, ""), tr(event.KindTurnAssistant), tr(event.KindTurnUser)}, false},
		{"transcript lines are not hooks", []event.Event{tr(event.KindTurnUser)}, false},
		{"a subagent's call is not the main thread's", []event.Event{hook(event.KindAgentStop, ""), sub(event.KindToolPre)}, false},
		{"a sidechain line is not the main thread's", []event.Event{hook(event.KindAgentStop, ""), hook(event.KindToolPre, `{"sidechain":true}`)}, false},
		{"a permission prompt is the user's", []event.Event{hook(event.KindTurnUser, ""), hook(event.KindPermissionPrompt, "")}, false},
		{"a limit ended it", []event.Event{hook(event.KindTurnUser, ""), hook(event.KindThrottle, "")}, false},
		{"the session ended", []event.Event{hook(event.KindTurnUser, ""), hook(event.KindSessionEnd, "")}, false},
		{"cleared", []event.Event{hook(event.KindTurnUser, ""), hook(event.KindContextClear, "")}, false},
		{"a fresh start", []event.Event{hook(event.KindAgentSpawn, `{"source":"startup"}`)}, false},
		{"auto compaction is the turn's", []event.Event{hook(event.KindTurnUser, ""), hook(event.KindContextCompact, `{"trigger":"auto"}`), hook(event.KindAgentSpawn, `{"source":"compact"}`)}, true},
		{"a manual /compact is not a turn", []event.Event{hook(event.KindAgentStop, ""), hook(event.KindContextCompact, `{"trigger":"manual"}`), hook(event.KindAgentSpawn, `{"source":"compact"}`)}, false},
		{"a notification Claude Code wrote is passed over", []event.Event{hook(event.KindAgentStop, ""), hook(event.KindTurnUser, `{"prompt":"<task-notification><status>done</status></task-notification>"}`)}, false},
		{"other kinds are passed over", []event.Event{hook(event.KindTurnUser, ""), hook(event.KindContextOverhead, "")}, true},
	}
	for _, tc := range cases {
		if got := TurnOpen(tc.evs); got != tc.want {
			t.Errorf("%s: TurnOpen = %v, want %v", tc.name, got, tc.want)
		}
	}
}
