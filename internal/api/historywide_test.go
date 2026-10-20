package api

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/rollup"
)

// A history that reaches before today is kept for historyWideTTL however
// cheap it was to count, while today's keeps historyTTL. With agents writing,
// the events version always moves, and an all-time count the page cache
// answers in milliseconds looked cheap to the cost bound: the Now screen's
// 10 s live poll then read every event in the database again on every poll —
// real disk reads on a machine short of memory (historyWideTTL).
func TestWideHistoryIsKeptForAMinuteWhileTodayMoves(t *testing.T) {
	e := newEnv(t)
	e.seed(t, t.TempDir())
	var mu sync.Mutex
	clock := time.Now()
	now := func() time.Time { mu.Lock(); defer mu.Unlock(); return clock }
	advance := func(d time.Duration) { mu.Lock(); clock = clock.Add(d); mu.Unlock() }
	e.api.hist.now, e.api.histWide.now = now, now

	turns := func(rng string) int {
		t.Helper()
		var h HistoryResponse
		if code := e.get(t, "/v1/history?range="+rng, &h); code != 200 {
			t.Fatalf("history %s: %d", rng, code)
		}
		return int(h.Summary.Turns)
	}
	// Ask, let any refresh the ask started land, and ask again.
	settled := func(rng string) int {
		t.Helper()
		_ = turns(rng)
		e.api.hist.wait()
		e.api.histWide.wait()
		return turns(rng)
	}
	allBefore, todayBefore := settled("all"), settled("today")

	ev := &event.Event{SessionID: "s1", Source: event.SourceTranscript, Kind: event.KindTurnAssistant, Key: "msg:m2",
		Ts: e.now.Add(3 * time.Second), Model: "claude-opus-5", Tokens: &event.TokenDelta{In: 10, Out: 20}, Payload: json.RawMessage(`{"text":"again"}`)}
	if _, err := e.rec.Record(context.Background(), ev, rollup.SessionInfo{}); err != nil {
		t.Fatal(err)
	}

	advance(10 * time.Second) // past historyTTL, inside historyWideTTL
	if got := settled("today"); got != todayBefore+1 {
		t.Fatalf("today after a new turn: %d turns, want %d", got, todayBefore+1)
	}
	if got := settled("all"); got != allBefore {
		t.Fatalf("all time %s after it was counted: %d turns, want the kept %d", 10*time.Second, got, allBefore)
	}

	advance(historyWideTTL)
	if got := settled("all"); got != allBefore+1 {
		t.Fatalf("all time past historyWideTTL: %d turns, want %d", got, allBefore+1)
	}
}
