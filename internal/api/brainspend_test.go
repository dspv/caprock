package api

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/store"
)

// GET /v1/brain/spend: the reads per local day and per project, the daily
// limit, and the last 24 hours of the reads and of Claude Code's sessions.
func TestBrainSpendEndpoint(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	now := e.api.d.Now()
	for id, p := range map[string]string{"s1": "acme-api", "s2": "web"} {
		if err := store.UpsertSession(ctx, e.st.DB(), id, store.SessionPatch{Project: p, LastEventAt: 1, StartedAt: 1, FromHook: true}); err != nil {
			t.Fatal(err)
		}
	}
	for _, r := range []store.BrainRun{
		{SessionID: "s1", Status: store.BrainRunOK, TokensIn: 80_000, TokensOut: 4_000, CostUSD: 0.09, Nodes: 4, FinishedAt: now.Add(-time.Hour).UnixMilli()},
		{SessionID: "s2", Status: store.BrainRunOK, TokensIn: 9_000, TokensOut: 1_000, Nodes: 2, FinishedAt: now.Add(-3 * 24 * time.Hour).UnixMilli()},
		{SessionID: "s2", Status: store.BrainRunOK, TokensIn: 5_000, FinishedAt: now.Add(-20 * 24 * time.Hour).UnixMilli()},
	} {
		r.StartedAt = r.FinishedAt
		if _, err := store.InsertBrainRun(ctx, e.st.DB(), r); err != nil {
			t.Fatal(err)
		}
	}
	ev := event.Event{SessionID: "s1", Source: event.SourceTranscript, Kind: event.KindTurnAssistant, Ts: now.Add(-2 * time.Hour), Key: "t1",
		Payload: []byte(`{"text":"x"}`), Tokens: &event.TokenDelta{In: 16_000, CacheRead: 300_000}}
	if _, err := store.InsertEvent(ctx, e.st.DB(), &ev); err != nil {
		t.Fatal(err)
	}

	var out BrainSpend
	if code := e.get(t, "/v1/brain/spend", &out); code != http.StatusOK {
		t.Fatalf("status %d", code)
	}
	if len(out.Days) != 14 || out.Days[13].Day != now.Format("2006-01-02") || out.Days[13].Tokens != 84_000 || out.Days[13].Reads != 1 ||
		out.Days[10].Tokens != 10_000 {
		t.Errorf("days: %+v", out.Days)
	}
	if len(out.Projects) != 2 || out.Projects[0].Project != "acme-api" || out.Projects[0].Memories != 4 || out.Projects[1].Tokens != 10_000 {
		t.Errorf("projects (the 20-day-old read is outside 14 days): %+v", out.Projects)
	}
	if out.Spent24h != 84_000 || out.ClaudeTokens24h != 316_000 || out.DailyTokens != 0 {
		t.Errorf("24 h: %+v (no engine, so no limit)", out)
	}
	e.api.d.BrainAuto = &fakeBrainAuto{}
	if code := e.get(t, "/v1/brain/spend?days=30", &out); code != http.StatusOK || len(out.Days) != 30 || out.DailyTokens != 300_000 || out.Projects[1].Tokens != 15_000 {
		t.Errorf("30 days: %d %d %+v", code, len(out.Days), out.Projects)
	}
	for _, bad := range []string{"0", "91", "x"} {
		if code := e.get(t, "/v1/brain/spend?days="+bad, nil); code != http.StatusBadRequest {
			t.Errorf("days=%s: %d", bad, code)
		}
	}
}
