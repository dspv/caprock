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

// Today's figures may be up to the kept parts' window behind (15 s), and no
// more: an answer built while the parts were held back is not renewed as
// current on an unchanged version, so once the window has passed the next
// ask shows the turn — with nothing written in between to move the version.
// A removal (forgetAnswers) is read at once.
func TestTodayCatchesUpPastThePartsWindow(t *testing.T) {
	e := newEnv(t)
	e.seed(t, t.TempDir())
	var mu sync.Mutex
	clock := time.Now()
	now := func() time.Time { mu.Lock(); defer mu.Unlock(); return clock }
	advance := func(d time.Duration) { mu.Lock(); clock = clock.Add(d); mu.Unlock() }
	e.api.hist.now, e.api.today.now = now, now
	e.api.parts.SetClock(now)

	summary := func() int64 {
		t.Helper()
		var s SummaryResponse
		if code := e.get(t, "/v1/stats/summary?range=today", &s); code != 200 {
			t.Fatalf("summary: %d", code)
		}
		return s.Turns
	}
	history := func() int64 {
		t.Helper()
		var h HistoryResponse
		if code := e.get(t, "/v1/history?range=today", &h); code != 200 {
			t.Fatalf("history: %d", code)
		}
		e.api.hist.wait()
		return h.Summary.Turns
	}
	both := func() (int64, int64) {
		t.Helper()
		_ = history() // a stale answer's refresh lands; the next ask has it
		return summary(), history()
	}
	sum0, hist0 := both()
	record := func(key string) {
		t.Helper()
		ev := &event.Event{SessionID: "s1", Source: event.SourceTranscript, Kind: event.KindTurnAssistant, Key: key,
			Ts: e.now.Add(3 * time.Second), Model: "claude-opus-5", Tokens: &event.TokenDelta{In: 10, Out: 20}, Payload: json.RawMessage(`{"text":"again"}`)}
		if _, err := e.rec.Record(context.Background(), ev, rollup.SessionInfo{}); err != nil {
			t.Fatal(err)
		}
	}

	// Right after the parts were read: the new turn waits for the window.
	record("msg:lag-1")
	advance(5 * time.Second)
	if s, h := both(); s != sum0 || h != hist0 {
		t.Fatalf("inside the window: summary %d history %d, want the kept %d and %d", s, h, sum0, hist0)
	}
	// Past it, nothing written since: both show the turn.
	advance(15 * time.Second)
	if s, h := both(); s != sum0+1 || h != hist0+1 {
		t.Fatalf("past the window: summary %d history %d, want %d and %d", s, h, sum0+1, hist0+1)
	}
	// And stay there.
	advance(5 * time.Second)
	if s, h := both(); s != sum0+1 || h != hist0+1 {
		t.Fatalf("settled: summary %d history %d, want %d and %d", s, h, sum0+1, hist0+1)
	}

	// A move right after a read, then a removal's forgetAnswers: read at once.
	record("msg:lag-2")
	advance(time.Second)
	e.api.forgetAnswers()
	e.api.today.forget()
	if s := summary(); s != sum0+2 {
		t.Fatalf("after forgetAnswers: summary %d, want %d", s, sum0+2)
	}
}
