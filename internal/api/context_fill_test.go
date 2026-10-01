package api

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/rollup"
)

// Context fill is the main thread's. A subagent starts from a fresh, small
// prompt, so a session measured by its subagent's last turn read nearly empty
// while its own context was nearly full — and against the subagent's window.
// A session whose every turn is a subagent's (an OpenCode child) is measured by
// them, since they are its own.
func TestContextFillIgnoresSubagentTurns(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	base := time.Now().Add(-time.Minute)
	cwd := t.TempDir()
	evs := []*event.Event{
		{SessionID: "parent", Source: event.SourceTranscript, Kind: event.KindTurnAssistant, Key: "msg:p1", Ts: base, Model: "claude-opus-5",
			Tokens: &event.TokenDelta{In: 1000, CacheRead: 700_000}, Payload: json.RawMessage(`{"sidechain":false}`)},
		{SessionID: "parent", Source: event.SourceTranscript, Kind: event.KindTurnAssistant, Key: "msg:s1", Ts: base.Add(time.Second), Model: "claude-haiku-4-5",
			AgentID: "a1", Tokens: &event.TokenDelta{In: 4000}, Payload: json.RawMessage(`{"sidechain":true}`)},
		{SessionID: "child", Source: event.SourceOpenCode, Kind: event.KindTurnAssistant, Key: "oc-msg:c1", Ts: base, Model: "claude-haiku-4-5",
			Tokens: &event.TokenDelta{In: 5000}, Payload: json.RawMessage(`{"sidechain":true}`)},
	}
	// Enough subagent events to push the main thread's turn out of the
	// summary's recent window, so the parent's turn has to be looked up
	// rather than found there.
	for i := 0; i < 80; i++ {
		evs = append(evs, &event.Event{SessionID: "parent", Source: event.SourceHook, Kind: event.KindToolPre, Tool: "Read", AgentID: "a1",
			Key: fmt.Sprintf("pre:r%d", i), Ts: base.Add(time.Duration(2+i) * time.Second), Payload: json.RawMessage(`{"tool_name":"Read"}`)})
	}
	for _, ev := range evs {
		if _, err := e.rec.Record(ctx, ev, rollup.SessionInfo{Cwd: cwd}); err != nil {
			t.Fatal(err)
		}
	}
	var list []SessionSummary
	if code := e.get(t, "/v1/sessions", &list); code != 200 {
		t.Fatalf("sessions: %d", code)
	}
	got := map[string]SessionSummary{}
	for _, s := range list {
		got[s.SessionID] = s
	}
	p := got["parent"]
	if p.Model != "claude-opus-5" {
		t.Errorf("parent model %q, want claude-opus-5", p.Model)
	}
	if p.Context == nil || p.Context.Tokens != 701_000 || p.Context.Window != 1_000_000 {
		t.Errorf("parent context %+v, want the main thread's 701000 of 1000000", p.Context)
	}
	c := got["child"]
	if c.Context == nil || c.Context.Tokens != 5000 || c.Context.Window != 200_000 {
		t.Errorf("child context %+v, want its own 5000 of 200000", c.Context)
	}
}
