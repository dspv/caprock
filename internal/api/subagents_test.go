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

// A Codex subagent's current call reads as the command its exec script ran.
func TestCallDetailReadsACodexScript(t *testing.T) {
	in := json.RawMessage(`{"command":"const r = await tools.exec_command({cmd:\"go vet ./...\"});text(r.output)\n"}`)
	if got := callDetail("exec", in); got != "go vet ./..." {
		t.Fatalf("callDetail = %q", got)
	}
	if got := callDetail("Bash", json.RawMessage(`{"command":"ls"}`)); got != "ls" {
		t.Fatalf("Bash callDetail = %q", got)
	}
}

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

	turn := func(ago time.Duration, agent, model string, usd *float64) {
		n++
		ev := &event.Event{
			SessionID: "s-par", Source: event.SourceTranscript, Kind: event.KindTurnAssistant, AgentID: agent, Model: model,
			Key: "t" + strconv.Itoa(n), Ts: e.now.Add(-ago), Tokens: &event.TokenDelta{In: 10}, CostUSD: usd, Payload: json.RawMessage(`{"sidechain":true}`),
		}
		if _, err := store.InsertEvent(context.Background(), e.st.DB(), ev); err != nil {
			t.Fatal(err)
		}
	}
	usd := func(v float64) *float64 { return &v }
	// a on Haiku, two priced turns; c on Sonnet, finished; b's turn is unpriced.
	turn(9*time.Minute, "a", "claude-haiku-4-5", usd(0.25))
	turn(20*time.Second, "a", "claude-haiku-4-5", usd(0.5))
	turn(3*time.Minute, "c", "claude-sonnet-4-5", usd(1))
	turn(5*time.Second, "b", "claude-sonnet-4-5", nil)

	var got SubagentsResponse
	e.get(t, "/v1/sessions/s-par/subagents", &got)
	if len(got.Recent) != 1 || got.Recent[0].AgentID != "c" || got.Recent[0].ModelDisplay != "Sonnet 4.5" || got.Recent[0].CostUSD == nil ||
		*got.Recent[0].CostUSD != 1 || got.Recent[0].StoppedAt != e.now.Add(-2*time.Minute).UnixMilli() || got.Recent[0].ToolCalls != 1 || got.Recent[0].AgentType != "Explore" {
		t.Errorf("recent = %+v", got.Recent)
	}
	// b cannot be priced, so neither can the total: nothing, never a zero.
	if got.CostUSD != nil {
		t.Errorf("total cost %v with an unpriced subagent turn; want none", *got.CostUSD)
	}
	if len(got.Working) == 2 {
		if b := got.Working[0]; b.CostUSD != nil || b.ModelDisplay != "Sonnet 4.5" {
			t.Errorf("unpriced b: model %q cost %v", b.ModelDisplay, b.CostUSD)
		}
		if a := got.Working[1]; a.CostUSD == nil || *a.CostUSD != 0.75 || a.ModelDisplay != "Haiku 4.5" || a.Model != "claude-haiku-4-5" {
			t.Errorf("a: model %q cost %v", a.ModelDisplay, a.CostUSD)
		}
	}
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
