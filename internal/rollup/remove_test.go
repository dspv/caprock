package rollup

import (
	"context"
	"encoding/json"
	"math"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/store"
)

// dayTotals sums daily_stats the way the screens read it.
func dayTotals(t *testing.T, st *store.Store) (cost float64, tokens, sessions int64) {
	t.Helper()
	err := st.DB().QueryRow(`SELECT COALESCE(SUM(cost_usd),0), COALESCE(SUM(tokens_total),0), COALESCE(SUM(sessions),0) FROM daily_stats`).
		Scan(&cost, &tokens, &sessions)
	if err != nil {
		t.Fatal(err)
	}
	return cost, tokens, sessions
}

func turn(id, key string, at time.Time, cwd string) *event.Event {
	p, _ := json.Marshal(map[string]string{"cwd": cwd})
	return &event.Event{
		SessionID: id, Source: event.SourceTranscript, Kind: event.KindTurnAssistant, Key: key,
		Ts: at, Model: "claude-opus-5", Tokens: &event.TokenDelta{In: 100_000, Out: 1000}, Payload: p,
	}
}

// Removing a session takes out exactly what it added — its cost, tokens and
// session count on every day it worked — and leaves another session sharing
// those daily rows alone. Its transcript is still on disk, so recording it
// again must not bring it back.
func TestARemovedSessionLeavesTheTotalsAndStaysGone(t *testing.T) {
	ctx := context.Background()
	r, _ := newRecorder(t)
	day1 := time.Date(2026, 9, 30, 10, 0, 0, 0, time.UTC)
	day2 := day1.Add(24 * time.Hour)
	record := func(ev *event.Event, cwd string) {
		t.Helper()
		if _, err := r.Record(ctx, ev, SessionInfo{Cwd: cwd}); err != nil {
			t.Fatal(err)
		}
	}
	// "keep" and "junk" share day 1's (day, project, model) row.
	record(turn("keep", "k1", day1, "/home/u/proj"), "/home/u/proj")
	record(turn("junk", "j1", day1.Add(time.Minute), "/home/u/proj"), "/home/u/proj")
	record(turn("junk", "j2", day2, "/home/u/proj"), "/home/u/proj")
	record(&event.Event{SessionID: "junk", Source: event.SourceHook, Kind: event.KindToolPre, Tool: "Write", Key: "w1", Ts: day2,
		Payload: json.RawMessage(`{"tool_input":{"file_path":"/home/u/proj/a.go"}}`)}, "/home/u/proj")

	costBefore, tokensBefore, sessionsBefore := dayTotals(t, r.Store)
	junk, _ := store.GetStats(ctx, r.Store.DB(), "junk")
	keep, _ := store.GetStats(ctx, r.Store.DB(), "keep")

	cands, err := store.FindRemovalCandidates(ctx, r.Store.DB(), []string{"junk"}, "")
	if err != nil || len(cands) != 1 {
		t.Fatalf("candidates: %+v %v", cands, err)
	}
	var missed float64
	err = r.Store.WithTx(ctx, func(q store.Querier) error {
		var err error
		missed, err = store.RemoveSession(ctx, q, cands[0], time.UTC, day2.UnixMilli())
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if missed != 0 {
		t.Fatalf("$%v was not found in the daily rows", missed)
	}

	costAfter, tokensAfter, sessionsAfter := dayTotals(t, r.Store)
	if math.Abs((costBefore-costAfter)-junk.CostUSD) > 1e-9 || costAfter != keep.CostUSD {
		t.Fatalf("cost %v → %v; the removed session cost %v, the kept one %v", costBefore, costAfter, junk.CostUSD, keep.CostUSD)
	}
	if tokensBefore-tokensAfter != junk.TokensIn+junk.TokensOut+junk.CacheRead+junk.CacheWrite {
		t.Fatalf("tokens %d → %d", tokensBefore, tokensAfter)
	}
	if sessionsBefore-sessionsAfter != 2 || sessionsAfter != 1 {
		t.Fatalf("session count %d → %d; junk counted on two days", sessionsBefore, sessionsAfter)
	}
	for _, table := range []string{"events", "sessions", "session_stats", "session_files", "daily_sessions"} {
		var n int
		if err := r.Store.DB().QueryRow(`SELECT COUNT(*) FROM ` + table + ` WHERE session_id = 'junk'`).Scan(&n); err != nil || n != 0 {
			t.Errorf("%s still holds %d rows of the removed session (%v)", table, n, err)
		}
	}
	if removed, _ := store.IsRemoved(ctx, r.Store.DB(), "junk"); !removed {
		t.Fatal("no tombstone")
	}

	// The transcript is read again: nothing comes back.
	res, err := r.Record(ctx, turn("junk", "j3", day2.Add(time.Hour), "/home/u/proj"), SessionInfo{Cwd: "/home/u/proj"})
	if err != nil || res.Stored {
		t.Fatalf("re-ingest of a removed session: %+v %v", res, err)
	}
	if _, err := store.GetSession(ctx, r.Store.DB(), "junk"); err == nil {
		t.Fatal("re-ingest brought the session back")
	}
	if c, _, _ := dayTotals(t, r.Store); c != costAfter {
		t.Fatalf("re-ingest moved the totals: %v → %v", costAfter, c)
	}
	// The kept session records as before.
	if res, err := r.Record(ctx, turn("keep", "k2", day2, "/home/u/proj"), SessionInfo{Cwd: "/home/u/proj"}); err != nil || !res.Stored {
		t.Fatalf("a kept session stopped recording: %+v %v", res, err)
	}
}

func TestRemovalCandidatesByFolder(t *testing.T) {
	ctx := context.Background()
	r, _ := newRecorder(t)
	at := time.Date(2026, 9, 30, 10, 0, 0, 0, time.UTC)
	for id, cwd := range map[string]string{
		"a": "/private/tmp/claude-501/x/scratchpad",
		"b": "/private/tmp/claude-501",
		"c": "/private/tmp/claude-5010/y", // a sibling that shares the prefix's characters
		"d": "/home/u/proj",
	} {
		if _, err := r.Record(ctx, turn(id, "k", at, cwd), SessionInfo{Cwd: cwd}); err != nil {
			t.Fatal(err)
		}
	}
	got, err := store.FindRemovalCandidates(ctx, r.Store.DB(), nil, "/private/tmp/claude-501/")
	if err != nil {
		t.Fatal(err)
	}
	ids := map[string]bool{}
	for _, c := range got {
		ids[c.SessionID] = true
	}
	if len(ids) != 2 || !ids["a"] || !ids["b"] {
		t.Fatalf("matched %v; want a and b", ids)
	}
	if _, err := store.FindRemovalCandidates(ctx, r.Store.DB(), nil, "  "); err == nil {
		t.Fatal("an empty filter matched")
	}
}

// A day row filed under a project name the folder no longer resolves to is
// still found when it holds exactly the session's turns.
func TestARemovedSessionsRenamedDayRowIsStillFound(t *testing.T) {
	ctx := context.Background()
	r, _ := newRecorder(t)
	at := time.Date(2026, 8, 22, 10, 0, 0, 0, time.UTC)
	if _, err := r.Record(ctx, turn("old", "k", at, "/work/hive2"), SessionInfo{Cwd: "/work/hive2"}); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Store.DB().Exec(`UPDATE daily_stats SET project = 'repo'`); err != nil {
		t.Fatal(err)
	}
	cands, _ := store.FindRemovalCandidates(ctx, r.Store.DB(), []string{"old"}, "")
	var missed float64
	err := r.Store.WithTx(ctx, func(q store.Querier) error {
		var err error
		missed, err = store.RemoveSession(ctx, q, cands[0], time.UTC, at.UnixMilli())
		return err
	})
	if err != nil || missed != 0 {
		t.Fatalf("missed $%v, %v", missed, err)
	}
	if c, tokens, _ := dayTotals(t, r.Store); c != 0 || tokens != 0 {
		t.Fatalf("the renamed day row still holds $%v, %d tokens", c, tokens)
	}
}
