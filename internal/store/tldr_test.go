package store

import (
	"context"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
)

func TestEventTLDRKeptAndGoneWithItsEvent(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	old := time.Now().AddDate(0, 0, -100)
	add := func(session, key string, ts time.Time) int64 {
		ev := &event.Event{SessionID: session, Source: event.SourceTranscript, Kind: event.KindTurnAssistant, Key: key, Ts: ts,
			Payload: []byte(`{"text":"an answer"}`)}
		id, err := InsertEvent(ctx, s.db, ev)
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	pruned, kept, removed := add("s1", "a", old), add("s1", "b", time.Now()), add("s2", "c", time.Now())

	if _, ok, err := GetEventTLDR(ctx, s.db, kept); ok || err != nil {
		t.Fatalf("nothing kept yet: %v %v", ok, err)
	}
	for _, id := range []int64{pruned, kept, removed} {
		if err := PutEventTLDR(ctx, s.db, EventTLDR{EventID: id, Text: "first", Model: "m", CostUSD: 0.001, CreatedAt: 1}); err != nil {
			t.Fatal(err)
		}
	}
	if err := PutEventTLDR(ctx, s.db, EventTLDR{EventID: kept, Text: "second", Model: "claude-haiku-5-5", CostUSD: 0.002, CreatedAt: 2}); err != nil {
		t.Fatal(err)
	}
	got, ok, err := GetEventTLDR(ctx, s.db, kept)
	if err != nil || !ok || got.Text != "second" || got.Model != "claude-haiku-5-5" || got.CostUSD != 0.002 || got.CreatedAt != 2 {
		t.Fatalf("replaced: %+v %v %v", got, ok, err)
	}

	if _, err := PruneEventsBefore(ctx, s.db, time.Now().AddDate(0, 0, -50).UnixMilli()); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := GetEventTLDR(ctx, s.db, pruned); ok {
		t.Error("a pruned event's AI;DR outlived it")
	}
	if _, err := RemoveSession(ctx, s.db, RemovalCandidate{SessionID: "s2"}, time.UTC, time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := GetEventTLDR(ctx, s.db, removed); ok {
		t.Error("a removed session's AI;DR outlived it")
	}
	if _, ok, _ := GetEventTLDR(ctx, s.db, kept); !ok {
		t.Error("the AI;DR of an event still there was dropped")
	}
}
