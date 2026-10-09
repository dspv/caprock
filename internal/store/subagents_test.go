package store

import (
	"context"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
)

// A subagent's spend is its own turns' cost, under the model it last ran;
// one turn the table could not price makes it, and the total, unknown — not
// a smaller number. A subagent with no turn has no spend at all.
func TestSubagentsSpend(t *testing.T) {
	ctx := context.Background()
	f := &weekFixture{t: t, s: openTest(t), loc: time.UTC}
	at := time.Date(2026, 10, 9, 12, 0, 0, 0, time.UTC)
	usd := func(v float64) *float64 { return &v }
	turn := func(sess, agent, model string, s int, cost *float64) {
		f.put(event.Event{SessionID: sess, AgentID: agent, Source: event.SourceTranscript, Kind: event.KindTurnAssistant, Model: model,
			Ts: at.Add(time.Duration(s) * time.Second), Tokens: &event.TokenDelta{In: 1}, CostUSD: cost})
	}
	turn("s", "", "claude-opus-5", 0, usd(9)) // the main thread is not a subagent
	turn("s", "a", "claude-sonnet-5", 1, usd(0.5))
	turn("s", "a", "claude-haiku-4-5", 2, usd(0.25))
	turn("s", "a", "codex-auto-review", 3, nil) // internal: left out, not "unpriced"
	turn("s", "b", "claude-haiku-4-5", 1, usd(0.1))
	f.put(event.Event{SessionID: "s", AgentID: "c", Source: event.SourceHook, Kind: event.KindToolPre, Tool: "Read", Ts: at})

	by, total, err := SubagentsSpend(ctx, f.s.DB(), "s")
	if err != nil {
		t.Fatal(err)
	}
	if a := by["a"]; a.Model != "claude-haiku-4-5" || !a.Known || a.CostUSD != 0.75 {
		t.Fatalf("a = %+v", a)
	}
	if _, ok := by["c"]; ok {
		t.Fatalf("c has no turn and no spend: %+v", by["c"])
	}
	if !total.Known || total.CostUSD < 0.849 || total.CostUSD > 0.851 {
		t.Fatalf("total = %+v; want 0.85 known", total)
	}

	turn("s", "b", "claude-haiku-4-5", 5, nil)
	by, total, err = SubagentsSpend(ctx, f.s.DB(), "s")
	if err != nil {
		t.Fatal(err)
	}
	if by["b"].Known || total.Known || !by["a"].Known {
		t.Fatalf("an unpriced turn must make b and the total unknown: b=%+v total=%+v", by["b"], total)
	}
	if _, total, _ := SubagentsSpend(ctx, f.s.DB(), "none"); total.Known {
		t.Fatalf("a session with no subagent turn has no known total")
	}
}
