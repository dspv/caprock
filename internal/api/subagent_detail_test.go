package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/store"
)

type subFixture struct {
	t   *testing.T
	e   *env
	n   int
	ids map[string]int64
}

func (f *subFixture) add(ago time.Duration, src event.Source, kind event.Kind, tool, agent, key, payload string) {
	f.t.Helper()
	f.n++
	if key == "" {
		key = "k" + strconv.Itoa(f.n)
	}
	ev := &event.Event{
		SessionID: "s-par", Source: src, Kind: kind, Tool: tool, AgentID: agent,
		Key: key, Ts: f.e.now.Add(-ago), Payload: json.RawMessage(payload),
	}
	id, err := store.InsertEvent(context.Background(), f.e.st.DB(), ev)
	if err != nil {
		f.t.Fatal(err)
	}
	f.ids[key] = id
}

func (f *subFixture) turn(ago time.Duration, agent string, usd *float64, tools string) {
	f.t.Helper()
	f.n++
	ev := &event.Event{
		SessionID: "s-par", Source: event.SourceTranscript, Kind: event.KindTurnAssistant, AgentID: agent, Model: "claude-haiku-4-5",
		Key: "t" + strconv.Itoa(f.n), Ts: f.e.now.Add(-ago), Tokens: &event.TokenDelta{In: 10, Out: 5, CacheRead: 100, CacheWrite: 20},
		CostUSD: usd, Payload: json.RawMessage(`{"sidechain":true,"tools":` + tools + `}`),
	}
	if _, err := store.InsertEvent(context.Background(), f.e.st.DB(), ev); err != nil {
		f.t.Fatal(err)
	}
}

// Opening a subagent: the task from the parent's Agent call that names it,
// its calls in order joined to their results (an error marked, the newest
// still open), what it answered from its SubagentStop, and its own numbers.
func TestSubagentDetailOpensAFinishedSubagent(t *testing.T) {
	e := newEnv(t)
	f := &subFixture{t: t, e: e, ids: map[string]int64{}}
	usd := func(v float64) *float64 { return &v }
	hook, tr := event.SourceHook, event.SourceTranscript
	// The parent launches "a" in the background.
	f.add(10*time.Minute, hook, event.KindToolPre, "Agent", "", "pre:par1",
		`{"tool_use_id":"par1","tool_input":{"description":"Fix the cockpit","prompt":"Read Cockpit.tsx\nand fix the clip.","subagent_type":"general-purpose"}}`)
	f.add(10*time.Minute-time.Second, hook, event.KindToolPost, "Agent", "", "post:par1",
		`{"tool_use_id":"par1","tool_input":{"description":"Fix the cockpit","prompt":"Read Cockpit.tsx\nand fix the clip.","subagent_type":"general-purpose"},"tool_response":{"isAsync":true,"status":"async_launched","agentId":"a","description":"Fix the cockpit"}}`)
	// Its calls: a Read, a Bash the transcript says failed (no hook result),
	// a Read heard on both planes (one row: same key), a Grep.
	f.add(9*time.Minute, hook, event.KindToolPre, "Read", "a", "pre:a1", `{"agent_type":"general-purpose","tool_use_id":"a1","tool_input":{"file_path":"/w/ui/Cockpit.tsx"}}`)
	f.add(9*time.Minute-2*time.Second, hook, event.KindToolPost, "Read", "a", "post:a1", `{"tool_use_id":"a1"}`)
	f.add(8*time.Minute, hook, event.KindToolPre, "Bash", "a", "pre:a2", `{"agent_type":"general-purpose","tool_use_id":"a2","tool_input":{"command":"go test ./...\nmore"}}`)
	f.add(8*time.Minute-5*time.Second, tr, event.KindToolPost, "", "a", "post:a2", `{"tool_use_id":"a2","is_error":true}`)
	f.add(7*time.Minute, hook, event.KindToolPre, "Grep", "a", "pre:a3", `{"agent_type":"general-purpose","tool_use_id":"a3","tool_input":{"pattern":"clip"}}`)
	f.add(6*time.Minute, hook, event.KindToolPost, "Grep", "a", "post:a3", `{"tool_use_id":"a3"}`)
	f.turn(9*time.Minute, "a", usd(0.30), `["Read"]`)
	f.turn(8*time.Minute, "a", usd(0.20), `["Bash","Grep"]`)
	f.turn(5*time.Minute, "a", usd(0.05), `[]`)
	f.add(4*time.Minute, hook, event.KindAgentStop, "", "a", "", `{"agent_id":"a","agent_type":"","last_assistant_message":"I fixed the clip.\nPR #1."}`)
	// Another subagent's call is not in a's feed.
	f.add(5*time.Minute, hook, event.KindToolPre, "Read", "b", "pre:b1", `{"tool_use_id":"b1"}`)

	var d SubagentDetail
	e.get(t, "/v1/sessions/s-par/subagents/a", &d)
	if d.AgentType != "general-purpose" || d.Description != "Fix the cockpit" || d.Prompt != "Read Cockpit.tsx\nand fix the clip." ||
		d.SubagentType != "general-purpose" || d.ParentToolUseID != "par1" || !d.Background {
		t.Errorf("task = %+v", d)
	}
	if d.State != "finished" || d.StoppedAt != e.now.Add(-4*time.Minute).UnixMilli() || d.Result != "I fixed the clip.\nPR #1." {
		t.Errorf("state %q stopped %d result %q", d.State, d.StoppedAt, d.Result)
	}
	if len(d.Calls) != 3 || d.Earlier != 0 {
		t.Fatalf("calls = %+v earlier %d", d.Calls, d.Earlier)
	}
	if c := d.Calls[0]; c.Tool != "Read" || c.Detail != "Cockpit.tsx" || c.EndedAt == 0 || c.Error {
		t.Errorf("read = %+v", c)
	}
	if c := d.Calls[1]; c.Tool != "Bash" || c.Detail != "go test ./..." || !c.Error || c.EndedAt == 0 {
		t.Errorf("bash = %+v", c)
	}
	st := d.Stats
	if st.ToolCalls != 3 || st.Turns != 3 || st.Tokens.In != 30 || st.Tokens.CacheRead != 300 || st.ModelDisplay != "Haiku 4.5" ||
		st.CostUSD == nil || *st.CostUSD < 0.549 || *st.CostUSD > 0.551 || st.DurationMs != (5*time.Minute).Milliseconds() {
		t.Errorf("stats = %+v cost %v", st, st.CostUSD)
	}
	// The costliest kind first: Read's whole turn, then Bash and Grep's halves.
	if len(st.ByTool) < 3 || st.ByTool[0].Tool != "Read" || st.ByTool[0].Calls != 1 || *st.ByTool[0].CostUSD != 0.30 ||
		st.ByTool[1].CostUSD == nil || *st.ByTool[1].CostUSD != 0.10 {
		t.Errorf("by tool = %+v", st.ByTool)
	}

	// Paging: the newest one, then what came before it.
	var page SubagentDetail
	e.get(t, "/v1/sessions/s-par/subagents/a?limit=1", &page)
	if len(page.Calls) != 1 || page.Calls[0].Tool != "Grep" || page.Earlier != 2 {
		t.Fatalf("newest page = %+v earlier %d", page.Calls, page.Earlier)
	}
	e.get(t, "/v1/sessions/s-par/subagents/a?limit=5&before="+strconv.FormatInt(page.Calls[0].ID, 10), &page)
	if len(page.Calls) != 2 || page.Calls[0].Tool != "Read" || page.Calls[1].Tool != "Bash" || page.Earlier != 0 {
		t.Fatalf("earlier page = %+v earlier %d", page.Calls, page.Earlier)
	}

	if code := e.get(t, "/v1/sessions/s-par/subagents/nobody", nil); code != http.StatusNotFound {
		t.Fatalf("unknown subagent: %d", code)
	}
}

// A foreground subagent still running: its parent's call has no result yet,
// so nothing names it — the newest unanswered call of its type made before
// it began gives the task. Its open call has no end, and it has no result.
// Once the call returns, its text is the answer when no SubagentStop
// carried one.
func TestSubagentDetailLinksAForegroundCall(t *testing.T) {
	e := newEnv(t)
	f := &subFixture{t: t, e: e, ids: map[string]int64{}}
	hook := event.SourceHook
	f.add(20*time.Minute, hook, event.KindToolPre, "Agent", "", "pre:old",
		`{"tool_use_id":"old","tool_input":{"description":"An older one","prompt":"x","subagent_type":"Explore"}}`)
	f.add(19*time.Minute, hook, event.KindToolPost, "Agent", "", "post:old", `{"tool_use_id":"old","tool_response":{"status":"completed","agentId":"z"}}`)
	f.add(3*time.Minute, hook, event.KindToolPre, "Agent", "", "pre:fg",
		`{"tool_use_id":"fg","tool_input":{"description":"Find the clip","prompt":"Search ui/ for the clip.","subagent_type":"Explore"}}`)
	f.add(2*time.Minute, hook, event.KindToolPre, "Grep", "e", "pre:e1", `{"agent_type":"Explore","tool_use_id":"e1","tool_input":{"pattern":"overflow"}}`)

	var d SubagentDetail
	e.get(t, "/v1/sessions/s-par/subagents/e", &d)
	if d.Description != "Find the clip" || d.Prompt != "Search ui/ for the clip." || d.ParentToolUseID != "fg" || d.Background {
		t.Errorf("task = %+v", d)
	}
	if d.State != "working" || d.Result != "" || len(d.Calls) != 1 || d.Calls[0].EndedAt != 0 || d.Stats.CostUSD != nil {
		t.Errorf("running = %+v", d)
	}

	f.add(time.Minute, hook, event.KindToolPost, "Grep", "e", "post:e1", `{"tool_use_id":"e1"}`)
	f.add(30*time.Second, hook, event.KindAgentStop, "", "e", "", `{"agent_id":"e"}`)
	f.add(29*time.Second, hook, event.KindToolPost, "Agent", "", "post:fg",
		`{"tool_use_id":"fg","tool_response":{"status":"completed","agentId":"e","content":[{"type":"text","text":"It is in Cockpit.tsx."},{"type":"text","text":"Line 200."}]}}`)
	e.get(t, "/v1/sessions/s-par/subagents/e", &d)
	if d.State != "finished" || d.Result != "It is in Cockpit.tsx.\n\nLine 200." || d.Calls[0].EndedAt == 0 {
		t.Errorf("returned = %+v", d)
	}
}

// ?recent= opens the "+N finished" list: more than three, never past 30.
func TestSessionSubagentsRecentAsksForMore(t *testing.T) {
	e := newEnv(t)
	f := &subFixture{t: t, e: e, ids: map[string]int64{}}
	for i := range 5 {
		id := "d" + strconv.Itoa(i)
		f.add(time.Duration(10-i)*time.Minute, event.SourceHook, event.KindToolPre, "Read", id, "pre:"+id, `{"agent_type":"Explore","tool_use_id":"`+id+`"}`)
		f.add(time.Duration(9-i)*time.Minute, event.SourceHook, event.KindAgentStop, "", id, "", `{"agent_type":""}`)
	}
	var got SubagentsResponse
	e.get(t, "/v1/sessions/s-par/subagents", &got)
	if got.Finished != 5 || len(got.Recent) != 3 {
		t.Fatalf("default: finished %d recent %d", got.Finished, len(got.Recent))
	}
	e.get(t, "/v1/sessions/s-par/subagents?recent=10", &got)
	if len(got.Recent) != 5 || got.Recent[0].AgentID != "d4" || got.Recent[4].AgentType != "Explore" {
		t.Fatalf("recent=10: %+v", got.Recent)
	}
}
