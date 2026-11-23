package api

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/rollup"
)

// A session's calls are kept while its events are as they were, and a new
// turn or a changed one shows on the very next ask.
func TestSessionCallsKeptByGeneration(t *testing.T) {
	e := newEnv(t)
	dir := t.TempDir()
	e.seed(t, dir)
	ctx := context.Background()
	calls := func() []SessionCall {
		t.Helper()
		var out []SessionCall
		if code := e.get(t, "/v1/sessions/s1/calls", &out); code != 200 {
			t.Fatalf("calls: %d", code)
		}
		return out
	}
	first := calls()
	if len(first) != 1 {
		t.Fatalf("one priced call, got %+v", first)
	}
	if again := calls(); len(again) != 1 || again[0].CostUSD != first[0].CostUSD {
		t.Fatalf("asked again: %+v", again)
	}
	if n := len(e.api.callsCache().m); n != 1 {
		t.Fatalf("one answer kept, got %d", n)
	}
	ev := &event.Event{SessionID: "s1", Source: event.SourceTranscript, Kind: event.KindTurnAssistant, Key: "msg:m2",
		Ts: e.now.Add(5 * time.Second), Model: "claude-opus-5", Tokens: &event.TokenDelta{In: 10, Out: 20}, Payload: json.RawMessage(`{"text":"more"}`)}
	if _, err := e.rec.Record(ctx, ev, rollup.SessionInfo{Cwd: dir}); err != nil {
		t.Fatal(err)
	}
	kept := e.api.calls.last("s1|0")
	if got := calls(); len(got) != 2 {
		t.Fatalf("a new turn must show at once: %+v", got)
	}
	if now := e.api.calls.last("s1|0"); kept == nil || now == nil || !kept.Mark.Older(now.Mark) || now.Mark.Gen != kept.Mark.Gen {
		t.Fatalf("the kept series must move to the new turn's state: %+v -> %+v", kept, now)
	}
	if _, err := e.st.DB().ExecContext(ctx, `UPDATE events SET cost_usd = 9.5 WHERE key = 'msg:m2'`); err != nil {
		t.Fatal(err)
	}
	if got := calls(); len(got) != 2 || got[1].CostUSD != 9.5 {
		t.Fatalf("a repriced turn must show at once: %+v", got)
	}
}
