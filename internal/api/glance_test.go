package api

import (
	"context"
	"math"
	"testing"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/store"
)

func TestGlanceSplitsAgentsAndPricesTheBillByTokenType(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	if err := store.UpsertSession(ctx, e.st.DB(), "g1", store.SessionPatch{Agent: "claude", StartedAt: 1, LastEventAt: 1}); err != nil {
		t.Fatal(err)
	}
	put := func(key, agentID string) {
		c := 1.0
		ev := event.Event{SessionID: "g1", AgentID: agentID, Source: event.SourceTranscript, Kind: event.KindTurnAssistant,
			Ts: e.now, Key: key, Model: "claude-opus-5", CostUSD: &c,
			Tokens: &event.TokenDelta{In: 1_000_000, Out: 1_000_000, CacheRead: 1_000_000, CacheWrite: 1_000_000}}
		if _, err := store.InsertEvent(ctx, e.st.DB(), &ev); err != nil {
			t.Fatal(err)
		}
	}
	put("t1", "")
	put("t2", "sub")
	var g GlanceResponse
	if code := e.get(t, "/v1/glance", &g); code != 200 {
		t.Fatalf("status %d", code)
	}
	if len(g.Agents) != 2 {
		t.Fatalf("agents %+v", g.Agents)
	}
	if g.Bill == nil {
		t.Fatal("no bill")
	}
	if g.Bill.CacheReadUSD <= 0 || g.Bill.OutputUSD <= g.Bill.InputUSD || math.IsNaN(g.Bill.CacheWriteUSD) {
		t.Fatalf("bill %+v", g.Bill)
	}
	if g.Display["claude-opus-5"] == "" {
		t.Fatalf("no display name: %+v", g.Display)
	}
}
