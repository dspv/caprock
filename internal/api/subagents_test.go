package api

import (
	"context"
	"encoding/json"
	"strconv"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/store"
)

// The cockpit's subagent list: who is working, what each is doing, how many
// calls it has made and whether it waits on a dialog — computed by the daemon,
// so a session with thousands of subagent events is not paged through.
func TestSessionSubagentsSaysWhoIsWorkingOnWhat(t *testing.T) {
	e := newEnv(t)
	n := 0
	add := func(ago time.Duration, kind event.Kind, tool, agent, payload string) {
		n++
		ev := &event.Event{
			SessionID: "s-par", Source: event.SourceHook, Kind: kind, Tool: tool, AgentID: agent,
			Key: "k" + strconv.Itoa(n), Ts: e.now.Add(-ago), Payload: json.RawMessage(payload),
		}
		if _, err := store.InsertEvent(context.Background(), e.st.DB(), ev); err != nil {
			t.Fatal(err)
		}
	}
	// a: general-purpose, three calls, the newest still running.
	add(9*time.Minute, event.KindToolPre, "Read", "a", `{"agent_type":"general-purpose","tool_use_id":"a1","tool_input":{"file_path":"/w/x.go"}}`)
	add(8*time.Minute, event.KindToolPost, "Read", "a", `{"tool_use_id":"a1"}`)
	add(7*time.Minute, event.KindToolPre, "Edit", "a", `{"agent_type":"general-purpose","tool_use_id":"a2","tool_input":{"file_path":"/w/session.go"}}`)
	add(6*time.Minute, event.KindToolPost, "Edit", "a", `{"tool_use_id":"a2"}`)
	add(10*time.Second, event.KindToolPre, "Bash", "a", `{"agent_type":"general-purpose","tool_use_id":"a3","tool_input":{"command":"go test ./...\nmore"}}`)
	// The parent launched it in the background; the launch names it.
	add(10*time.Minute, event.KindToolPost, "Agent", "", `{"tool_response":{"isAsync":true,"agentId":"a","description":"Fix the cockpit"}}`)
	// b: Explore, waiting on a permission dialog.
	add(5*time.Second, event.KindToolPre, "Bash", "b", `{"agent_type":"Explore","tool_use_id":"b1","tool_input":{"command":"rm -f out/*"}}`)
	add(4*time.Second, event.KindPermissionPrompt, "Bash", "b", `{"agent_type":"Explore","tool_name":"Bash"}`)
	// c: finished; d: an internal agent that ran no tool; old: out of the window.
	add(3*time.Minute, event.KindToolPre, "Grep", "c", `{"agent_type":"Explore","tool_use_id":"c1"}`)
	add(2*time.Minute, event.KindAgentStop, "", "c", `{}`)
	add(time.Minute, event.KindAgentStop, "", "d", `{"agent_type":""}`)
	add(2*time.Hour, event.KindToolPre, "Read", "old", `{"tool_use_id":"o1"}`)

	var got SubagentsResponse
	e.get(t, "/v1/sessions/s-par/subagents", &got)
	if got.Finished != 1 || len(got.Working) != 2 {
		t.Fatalf("finished %d, working %+v", got.Finished, got.Working)
	}
	b, a := got.Working[0], got.Working[1]
	if b.AgentID != "b" || b.AgentType != "Explore" || !b.Asking || b.Tool != "Bash" || b.Detail != "rm -f out/*" || b.ToolCalls != 1 {
		t.Errorf("b = %+v", b)
	}
	if a.AgentID != "a" || a.AgentType != "general-purpose" || a.Description != "Fix the cockpit" || a.Tool != "Bash" ||
		a.Detail != "go test ./..." || !a.Running || a.Asking || a.ToolCalls != 3 || a.ToolAt != e.now.Add(-10*time.Second).UnixMilli() {
		t.Errorf("a = %+v", a)
	}
}
