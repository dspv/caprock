package store

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
)

// The scrubber's series: the main thread's priced calls, oldest first, each
// with the tool calls it asked for by msg_id. An unpriced turn, a subagent's
// turn and a tool call of another message are not in it.
func TestSessionCalls(t *testing.T) {
	ctx := context.Background()
	f := &weekFixture{t: t, s: openTest(t), loc: time.UTC}
	at := time.Date(2026, 10, 9, 12, 0, 0, 0, time.UTC)
	usd := func(v float64) *float64 { return &v }
	turn := func(agent, msg string, s int, cost *float64) {
		f.put(event.Event{SessionID: "s", AgentID: agent, Source: event.SourceTranscript, Kind: event.KindTurnAssistant, Model: "claude-opus-5",
			Ts: at.Add(time.Duration(s) * time.Second), Tokens: &event.TokenDelta{In: 3, Out: 40, CacheRead: 900}, CostUSD: cost, MsgID: msg, Key: "msg:" + msg})
	}
	tool := func(msg, name, input string, s int) {
		p, _ := json.Marshal(map[string]any{"tool_name": name, "tool_input": json.RawMessage(input)})
		f.put(event.Event{SessionID: "s", Source: event.SourceTranscript, Kind: event.KindToolPre, Tool: name, MsgID: msg,
			Ts: at.Add(time.Duration(s) * time.Second), Payload: p, Key: "pre:" + msg + name})
	}
	turn("", "m2", 2, usd(0.2))
	turn("", "m1", 1, usd(0.1))
	turn("", "m3", 3, nil) // unpriced
	turn("a", "m4", 4, usd(9))
	tool("m1", "Bash", `{"command":"go test ./..."}`, 1)
	tool("m1", "Read", `{"file_path":"/x/y/main.go"}`, 1)
	tool("m9", "Bash", `{"command":"ls"}`, 5)

	got, err := SessionCalls(ctx, f.s.DB(), "s", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].CostUSD != 0.1 || got[1].CostUSD != 0.2 {
		t.Fatalf("calls = %+v, want m1 then m2", got)
	}
	if got[0].Tokens == nil || got[0].Tokens.CacheRead != 900 || got[0].Model != "claude-opus-5" {
		t.Fatalf("first call = %+v", got[0])
	}
	if got[0].ToolCount != 2 || got[0].Tools[0].Tool != "Bash" || got[0].Tools[1].Tool != "Read" || len(got[1].Tools) != 0 {
		t.Fatalf("tools = %+v / %+v", got[0].Tools, got[1].Tools)
	}
	if last, _ := SessionCalls(ctx, f.s.DB(), "s", 1); len(last) != 1 || last[0].CostUSD != 0.2 {
		t.Fatalf("limit 1 = %+v, want the newest", last)
	}
}
