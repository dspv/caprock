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

func TestGlanceTrendSplitsTheLastTwoWeeks(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	put := func(sid, agent, key, model string, cost float64, ts time.Time, tool string) {
		if err := store.UpsertSession(ctx, e.st.DB(), sid, store.SessionPatch{Agent: agent, StartedAt: ts.UnixMilli(), LastEventAt: ts.UnixMilli()}); err != nil {
			t.Fatal(err)
		}
		ev := event.Event{SessionID: sid, Source: event.SourceTranscript, Kind: event.KindTurnAssistant,
			Ts: ts, Key: key, Model: model, CostUSD: &cost, Tokens: &event.TokenDelta{In: 10, Out: 10, CacheRead: 100}}
		if _, err := store.InsertEvent(ctx, e.st.DB(), &ev); err != nil {
			t.Fatal(err)
		}
		pre := event.Event{SessionID: sid, Source: event.SourceHook, Kind: event.KindToolPre, Ts: ts, Key: key + "-pre", Tool: tool}
		if _, err := store.InsertEvent(ctx, e.st.DB(), &pre); err != nil {
			t.Fatal(err)
		}
	}
	put("r", "claude", "r1", "claude-opus-5-5", 3, e.now.Add(-time.Hour), "Bash")
	put("r", "claude", "r2", "claude-opus-5", 1, e.now.Add(-2*time.Hour), "Read")
	put("p", "codex", "p1", "claude-opus-5", 4, e.now.Add(-10*24*time.Hour), "Read")
	// Older than both windows: in all time only.
	put("o", "claude", "o1", "claude-opus-5", 50, e.now.Add(-30*24*time.Hour), "Edit")

	var g GlanceResponse
	if code := e.get(t, "/v1/glance", &g); code != 200 {
		t.Fatalf("status %d", code)
	}
	tr := g.Trend
	if tr == nil || tr.Days != 7 {
		t.Fatalf("trend %+v", tr)
	}
	if tr.Recent.Models["claude-opus-5-5"] != 3 || tr.Recent.Models["claude-opus-5"] != 1 {
		t.Fatalf("recent models %+v", tr.Recent.Models)
	}
	if tr.Prior.Models["claude-opus-5"] != 4 || len(tr.Prior.Models) != 1 {
		t.Fatalf("prior models %+v", tr.Prior.Models)
	}
	if tr.Recent.Tools["Bash"] != 1 || tr.Recent.Tools["Read"] != 1 || tr.Prior.Tools["Read"] != 1 || tr.Prior.Tools["Edit"] != 0 {
		t.Fatalf("tools recent %+v prior %+v", tr.Recent.Tools, tr.Prior.Tools)
	}
	if len(tr.Prior.Agents) != 1 || tr.Prior.Agents[0].Agent != "codex" || len(tr.Recent.Agents) != 1 || tr.Recent.Agents[0].Agent != "claude" {
		t.Fatalf("agents prior %+v recent %+v", tr.Prior.Agents, tr.Recent.Agents)
	}
	if tr.Recent.Bill == nil || tr.Recent.Bill.CacheReadUSD <= 0 {
		t.Fatalf("recent bill %+v", tr.Recent.Bill)
	}
	// A ranged answer carries no trend.
	var r GlanceResponse
	if code := e.get(t, "/v1/glance?range=7d", &r); code != 200 || r.Trend != nil {
		t.Fatalf("ranged: status %d trend %+v", code, r.Trend)
	}
}
