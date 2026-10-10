package api

import (
	"context"
	"math"
	"testing"
	"time"

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

func TestGlanceRangeSplitsOnlyThePeriod(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	put := func(sid, agent, key string, ts time.Time) {
		if err := store.UpsertSession(ctx, e.st.DB(), sid, store.SessionPatch{Agent: agent, StartedAt: ts.UnixMilli(), LastEventAt: ts.UnixMilli()}); err != nil {
			t.Fatal(err)
		}
		c := 2.0
		ev := event.Event{SessionID: sid, Source: event.SourceTranscript, Kind: event.KindTurnAssistant,
			Ts: ts, Key: key, Model: "claude-opus-5", CostUSD: &c, Tokens: &event.TokenDelta{In: 10, Out: 10}}
		if _, err := store.InsertEvent(ctx, e.st.DB(), &ev); err != nil {
			t.Fatal(err)
		}
	}
	put("new", "claude", "n1", e.now)
	// Forty days back: in all time, in no shorter range.
	put("old", "codex", "o1", e.now.Add(-40*24*time.Hour))
	agents := func(path string) map[string]bool {
		var g GlanceResponse
		if code := e.get(t, path, &g); code != 200 {
			t.Fatalf("%s: status %d", path, code)
		}
		seen := map[string]bool{}
		for _, a := range g.Agents {
			seen[a.Agent] = true
		}
		return seen
	}
	if got := agents("/v1/glance"); !got["claude"] || !got["codex"] {
		t.Fatalf("all time: %v", got)
	}
	if got := agents("/v1/glance?range=7d"); !got["claude"] || got["codex"] {
		t.Fatalf("7d: %v", got)
	}
}
