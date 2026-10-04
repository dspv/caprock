package store

import (
	"context"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
)

func TestLiveSubagentsCountsUntilTheStop(t *testing.T) {
	ctx := context.Background()
	f := &weekFixture{t: t, s: openTest(t), loc: time.UTC}
	now := time.Date(2026, 10, 4, 12, 0, 0, 0, time.UTC)
	call := func(agentID string, kind event.Kind, at time.Time) {
		f.put(event.Event{SessionID: "s", AgentID: agentID, Source: event.SourceHook, Kind: kind, Tool: "Bash", Ts: at})
	}
	// a: working. b: stopped. c: never stopped, but silent past the window.
	// The main thread's own events are not a subagent.
	call("a", event.KindToolPre, now.Add(-time.Minute))
	call("b", event.KindToolPre, now.Add(-3*time.Minute))
	call("b", event.KindAgentStop, now.Add(-2*time.Minute))
	call("c", event.KindToolPre, now.Add(-2*time.Hour))
	call("", event.KindToolPre, now.Add(-10*time.Second))

	n, err := LiveSubagents(ctx, f.s.DB(), "s", now.Add(-30*time.Minute).UnixMilli())
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("live subagents %d, want 1", n)
	}
}

func TestTokensByModelSumsEachType(t *testing.T) {
	ctx := context.Background()
	f := &weekFixture{t: t, s: openTest(t), loc: time.UTC}
	at := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	for i := 0; i < 2; i++ {
		f.put(event.Event{SessionID: "s", Source: event.SourceTranscript, Kind: event.KindTurnAssistant, Ts: at, Model: "m",
			Tokens: &event.TokenDelta{In: 1, Out: 2, CacheRead: 3, CacheWrite: 4, CacheWrite1h: 1}})
	}
	got, err := TokensByModel(ctx, f.s.DB(), 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0] != (ModelTokens{Model: "m", In: 2, Out: 4, CacheRead: 6, CacheWrite: 8, CacheWrite1h: 2}) {
		t.Fatalf("got %+v", got)
	}
}
