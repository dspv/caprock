package rollup

import (
	"context"
	"math"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/store"
)

// One API response, as a fork's transcript and its parent's both carry it.
func forkTurn(session, msg string, at time.Time, tokens event.TokenDelta) *event.Event {
	return &event.Event{Ts: at, SessionID: session, Source: event.SourceTranscript, Kind: event.KindTurnAssistant,
		Model: "claude-sonnet-4-5", Key: "msg:" + msg, MsgID: msg, Tokens: &tokens,
		Payload: []byte(`{"text":"the prose","message_id":"` + msg + `"}`)}
}

var forkUsage = event.TokenDelta{In: 1_000, Out: 2_000, CacheRead: 900_000, CacheWrite: 5_000, CacheWrite1h: 5_000}

func dailyCost(t *testing.T, r *Recorder) float64 {
	t.Helper()
	var usd float64
	if err := r.Store.DB().QueryRow(`SELECT COALESCE(SUM(cost_usd),0) FROM daily_stats`).Scan(&usd); err != nil {
		t.Fatal(err)
	}
	return usd
}

func eventsCost(t *testing.T, r *Recorder) float64 {
	t.Helper()
	var usd float64
	if err := r.Store.DB().QueryRow(`SELECT COALESCE(SUM(cost_usd),0) FROM events WHERE kind = 'turn.assistant'`).Scan(&usd); err != nil {
		t.Fatal(err)
	}
	return usd
}

// A fork repeats its parent's turns under its own session id. The copy is
// stored — it is the fork's history and carries its prose — but it is billed
// to nobody: every total holds the response once.
func TestForkCopyOfATurnIsNotPricedAgain(t *testing.T) {
	r, _ := newRecorder(t)
	ctx := context.Background()
	at := time.Date(2026, 9, 2, 6, 38, 6, 0, time.UTC)
	info := SessionInfo{Cwd: "/repo", Agent: "claude"}

	if _, err := r.Record(ctx, forkTurn("parent", "msg_1", at, forkUsage), info); err != nil {
		t.Fatal(err)
	}
	parent, _ := store.GetStats(ctx, r.Store.DB(), "parent")
	if parent.CostUSD <= 0 {
		t.Fatalf("the original was not priced: %+v", parent)
	}

	res, err := r.Record(ctx, forkTurn("fork", "msg_1", at, forkUsage), info)
	if err != nil || !res.Stored {
		t.Fatalf("the copy must still be stored for the fork's timeline: stored=%v err=%v", res.Stored, err)
	}
	fork, _ := store.GetStats(ctx, r.Store.DB(), "fork")
	if fork.CostUSD != 0 || fork.TokensIn+fork.TokensOut+fork.CacheRead+fork.CacheWrite != 0 {
		t.Fatalf("the copy was billed again: %+v", fork)
	}
	if fork.Turns != 1 {
		t.Fatalf("the copy is still a turn in the fork's history: turns = %d", fork.Turns)
	}
	var text string
	if err := r.Store.DB().QueryRow(`SELECT json_extract(payload,'$.text') FROM events WHERE session_id = 'fork'`).Scan(&text); err != nil || text != "the prose" {
		t.Fatalf("the copy lost its prose: %q, %v", text, err)
	}
	if got := eventsCost(t, r); math.Abs(got-parent.CostUSD) > 1e-9 {
		t.Fatalf("events total %v, want the response once (%v)", got, parent.CostUSD)
	}
	if got := dailyCost(t, r); math.Abs(got-parent.CostUSD) > 1e-9 {
		t.Fatalf("daily total %v, want the response once (%v)", got, parent.CostUSD)
	}

	// Re-reading the parent's transcript after a restart changes nothing.
	if res, err := r.Record(ctx, forkTurn("parent", "msg_1", at, forkUsage), info); err != nil || res.Stored {
		t.Fatalf("re-read stored=%v err=%v", res.Stored, err)
	}

	// A turn of the fork's own is priced as usual.
	if _, err := r.Record(ctx, forkTurn("fork", "msg_2", at.Add(time.Minute), forkUsage), info); err != nil {
		t.Fatal(err)
	}
	if fork, _ = store.GetStats(ctx, r.Store.DB(), "fork"); math.Abs(fork.CostUSD-parent.CostUSD) > 1e-9 {
		t.Fatalf("the fork's own turn was not priced: %+v", fork)
	}
}

// Claude Code zeroes the usage of the first turns a compaction preserves, so a
// copy can carry nothing. If that copy is stored first, it has not paid, and
// the original must still be priced when it arrives.
func TestAnEmptyCopyDoesNotStopTheOriginalBeingPriced(t *testing.T) {
	r, _ := newRecorder(t)
	ctx := context.Background()
	at := time.Date(2026, 9, 2, 6, 38, 6, 0, time.UTC)
	info := SessionInfo{Cwd: "/repo", Agent: "claude"}

	if _, err := r.Record(ctx, forkTurn("fork", "msg_1", at, event.TokenDelta{}), info); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Record(ctx, forkTurn("parent", "msg_1", at, forkUsage), info); err != nil {
		t.Fatal(err)
	}
	if parent, _ := store.GetStats(ctx, r.Store.DB(), "parent"); parent.CostUSD <= 0 {
		t.Fatalf("the original lost its cost to an empty copy: %+v", parent)
	}
}

// Copies stored by earlier versions are taken back out of the events and of
// both rollups, once. The row with usage pays, even when it was stored later
// than an empty copy.
func TestRepairForkedTurnsRemovesStoredCopies(t *testing.T) {
	r, _ := newRecorder(t)
	ctx := context.Background()
	at := time.Date(2026, 9, 2, 6, 38, 6, 0, time.UTC)
	info := SessionInfo{Cwd: "/repo", Agent: "claude"}

	// What earlier versions stored: each copy priced in full. The write path
	// no longer produces this, so the copies are recorded without a message id
	// and given it afterwards.
	record := func(session, msg string, tokens event.TokenDelta) {
		ev := forkTurn(session, msg, at, tokens)
		ev.MsgID = ""
		if _, err := r.Record(ctx, ev, info); err != nil {
			t.Fatal(err)
		}
		if _, err := r.Store.DB().Exec(`UPDATE events SET msg_id = ? WHERE session_id = ? AND key = ?`, msg, session, "msg:"+msg); err != nil {
			t.Fatal(err)
		}
	}
	record("fork", "msg_0", event.TokenDelta{CacheWrite1h: 301}) // the zeroed copy, as the old parser read it, stored first
	record("parent", "msg_0", forkUsage)
	record("parent", "msg_1", forkUsage)
	record("fork", "msg_1", forkUsage)
	record("fork", "msg_2", forkUsage) // the fork's own turn

	parentBefore, _ := store.GetStats(ctx, r.Store.DB(), "parent")
	forkBefore, _ := store.GetStats(ctx, r.Store.DB(), "fork")
	if got := eventsCost(t, r); math.Abs(got-(parentBefore.CostUSD+forkBefore.CostUSD)) > 1e-9 || forkBefore.CostUSD <= parentBefore.CostUSD {
		t.Fatalf("setup did not double-count: parent %v fork %v", parentBefore.CostUSD, forkBefore.CostUSD)
	}

	n, err := r.RepairForkedTurns(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("repaired %d copies, want 2 (the empty copy with a stray 1h figure, and the full one)", n)
	}
	parent, _ := store.GetStats(ctx, r.Store.DB(), "parent")
	fork, _ := store.GetStats(ctx, r.Store.DB(), "fork")
	if parent != parentBefore {
		t.Fatalf("the parent's totals moved: %+v -> %+v", parentBefore, parent)
	}
	one := parent.CostUSD / 2 // the parent holds two identical turns
	if math.Abs(fork.CostUSD-one) > 1e-9 || fork.Turns != 3 {
		t.Fatalf("fork = %+v, want only its own turn's cost (%v) and all three turns", fork, one)
	}
	want := parent.CostUSD + one
	if got := eventsCost(t, r); math.Abs(got-want) > 1e-9 {
		t.Fatalf("events total %v, want %v", got, want)
	}
	if got := dailyCost(t, r); math.Abs(got-want) > 1e-9 {
		t.Fatalf("daily total %v, want %v", got, want)
	}
	var tokens int64
	if err := r.Store.DB().QueryRow(`SELECT SUM(tokens_total) FROM daily_stats`).Scan(&tokens); err != nil || tokens != 3*forkUsage.Total() {
		t.Fatalf("daily tokens %d, want %d (%v)", tokens, 3*forkUsage.Total(), err)
	}

	// Once, and idempotent even when forced to run again.
	if n, _ := r.RepairForkedTurns(ctx); n != 0 {
		t.Fatalf("second pass repaired %d", n)
	}
	if err := r.Store.SetMeta(ctx, store.MetaForkedTurnsRepaired, ""); err != nil {
		t.Fatal(err)
	}
	if n, _ := r.RepairForkedTurns(ctx); n != 0 {
		t.Fatalf("a forced second pass repaired %d", n)
	}
}
