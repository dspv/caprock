package store

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
)

// seedUsage writes one assistant row for a session of the given agent:
// a reply when usageOnly is false, an importer's usage record otherwise.
func seedUsage(t *testing.T, st *Store, id, agent, model, key string, ts int64, cost float64, requests int64, usageOnly bool) {
	t.Helper()
	ctx := context.Background()
	src := event.SourceTranscript
	if agent == "cursor" {
		src = event.SourceCursor
	}
	fields := map[string]any{"model": model}
	if usageOnly {
		fields["usage_only"] = true
	}
	if requests > 0 {
		fields["requests"] = requests
	}
	payload, _ := json.Marshal(fields)
	err := st.WithTx(ctx, func(q Querier) error {
		if err := UpsertSession(ctx, q, id, SessionPatch{
			Cwd: "/home/dev/p", Project: "p", Model: model,
			StartedAt: ts, LastEventAt: ts, Agent: agent,
		}); err != nil {
			return err
		}
		c := cost
		_, err := InsertEvent(ctx, q, &event.Event{
			Ts: time.UnixMilli(ts), SessionID: id, Source: src,
			Kind: event.KindTurnAssistant, Model: model, Key: key,
			Tokens: &event.TokenDelta{In: 100, Out: 10}, CostUSD: &c, Payload: payload,
		})
		return err
	})
	if err != nil {
		t.Fatalf("seed %s: %v", key, err)
	}
}

// Cursor's opus-thinking on the owner's machine was 7 usage records, $623
// and 2,153 requests, and the Cost screen read it as "$89 per turn". A
// usage record is not a turn, and the requests are carried instead.
func TestUsageRecordsAreNotTurns(t *testing.T) {
	st := filterStore(t)
	ctx := context.Background()
	now := time.Now().UnixMilli()
	// Two Cursor chats whose money arrived on usage records only.
	seedUsage(t, st, "cu1", "cursor", "opus-thinking", "cu-usage:1", now, 248.01, 806, true)
	seedUsage(t, st, "cu2", "cursor", "opus-thinking", "cu-usage:2", now, 375.07, 1347, true)
	// A Cursor reply that carried its chat's difference: a real turn.
	seedUsage(t, st, "cu3", "cursor", "composer-1", "r1", now, 1.00, 50, false)
	seedUsage(t, st, "cu3", "cursor", "composer-1", "r2", now, 0, 0, false)
	// Hermes's usage record: not a turn, and Hermes counts no requests.
	seedUsage(t, st, "hm1", "hermes", "kimi", "hm-usage:1", now, 2, 0, true)
	seedUsage(t, st, "hm1", "hermes", "kimi", "h2", now, 1, 0, false)
	// Claude Code's turns are untouched.
	seedUsage(t, st, "cc1", "claude", "opus", "c1", now, 3, 0, false)

	s, err := SummarizeSparkFor(ctx, st.DB(), now-60_000, SparkSpec{}, "")
	if err != nil {
		t.Fatal(err)
	}
	by := map[string]ModelShare{}
	for _, m := range s.Models {
		by[m.Model] = m
	}
	if m := by["opus-thinking"]; m.Turns != 0 || m.Requests != 2153 || m.RequestsCostUSD < 623.07 || m.RequestsCostUSD > 623.09 {
		t.Errorf("opus-thinking = %+v, want 0 turns, 2153 requests, $623.08 of them", m)
	}
	if m := by["composer-1"]; m.Turns != 2 || m.Requests != 50 {
		t.Errorf("composer-1 = %+v, want 2 turns, 50 requests", m)
	}
	if m := by["kimi"]; m.Turns != 1 || m.Requests != 0 {
		t.Errorf("kimi = %+v, want 1 turn, no requests", m)
	}
	if m := by["opus"]; m.Turns != 1 || m.Requests != 0 {
		t.Errorf("opus = %+v, want 1 turn", m)
	}
	if s.Turns != 4 {
		t.Errorf("turns = %d, want 4 (two Cursor replies, one Hermes, one Claude)", s.Turns)
	}

	// The same under an agent filter, and nothing of Cursor's under Claude.
	c, err := SummarizeSparkFor(ctx, st.DB(), now-60_000, SparkSpec{}, "cursor")
	if err != nil {
		t.Fatal(err)
	}
	if c.Turns != 2 {
		t.Errorf("cursor turns = %d, want 2", c.Turns)
	}
	cl, err := SummarizeSparkFor(ctx, st.DB(), now-60_000, SparkSpec{}, "claude")
	if err != nil {
		t.Fatal(err)
	}
	if cl.Turns != 1 || len(cl.Models) != 1 || cl.Models[0].Requests != 0 {
		t.Errorf("claude summary = %d turns %+v", cl.Turns, cl.Models)
	}

	// The Week's split by agent and its turn count agree.
	agents, err := AgentSplit(ctx, st.DB(), now-60_000, 0)
	if err != nil {
		t.Fatal(err)
	}
	ag := map[string]WeekAgent{}
	for _, a := range agents {
		ag[a.Agent] = a
	}
	if a := ag["cursor"]; a.Turns != 2 || a.Requests != 2203 {
		t.Errorf("cursor agent = %+v, want 2 turns, 2203 requests", a)
	}
	if a := ag["hermes"]; a.Turns != 1 {
		t.Errorf("hermes agent = %+v, want 1 turn", a)
	}
	w, err := WeekStats(ctx, st.DB(), WeekOptions{From: time.UnixMilli(now - 60_000), To: time.UnixMilli(now + 60_000)})
	if err != nil {
		t.Fatal(err)
	}
	if w.Turns != 4 {
		t.Errorf("week turns = %d, want 4", w.Turns)
	}
}
