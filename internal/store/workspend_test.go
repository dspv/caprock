package store

import (
	"context"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
)

// Today's spend per live session: only the given sessions, only from the
// cut, and Caprock's own model work left out.
func TestSpendBySessionSince(t *testing.T) {
	ctx := context.Background()
	st, err := Open(ctx, ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	db := st.DB()
	cut := time.Date(2026, 10, 15, 0, 0, 0, 0, time.UTC)
	n := 0
	turn := func(session string, at time.Time, usd float64) int64 {
		t.Helper()
		n++
		ev := &event.Event{SessionID: session, Source: event.SourceTranscript, Kind: event.KindTurnAssistant, Ts: at, CostUSD: &usd, Model: "claude-opus-4-1", Key: "k" + string(rune('a'+n)), Payload: []byte("{}")}
		id, err := InsertEvent(ctx, db, ev)
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	turn("a", cut.Add(-time.Hour), 5) // yesterday
	turn("a", cut.Add(time.Hour), 1.25)
	turn("a", cut.Add(2*time.Hour), 0.75)
	turn("b", cut.Add(time.Minute), 3)
	internal := turn("b", cut.Add(2*time.Minute), 100)
	if _, err := db.Exec(`UPDATE events SET internal = 1 WHERE id = ?`, internal); err != nil {
		t.Fatal(err)
	}
	turn("c", cut.Add(time.Hour), 9) // not asked for
	turn("d", cut.Add(-time.Minute), 4)

	got, err := SpendBySessionSince(ctx, db, []string{"a", "b", "d", "none"}, cut.UnixMilli())
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got["a"] != 2 || got["b"] != 3 {
		t.Fatalf("spend = %v, want a 2, b 3 and nothing else", got)
	}
	if got, err := SpendBySessionSince(ctx, db, nil, cut.UnixMilli()); err != nil || len(got) != 0 {
		t.Fatalf("no sessions: %v %v", got, err)
	}
}

// The repositories worked in lately, newest first, each with its newest
// session; folders outside a repository and old sessions are not there.
func TestRecentRepos(t *testing.T) {
	ctx := context.Background()
	st, err := Open(ctx, ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	db := st.DB()
	add := func(id, root string, at int64) {
		t.Helper()
		if err := UpsertSession(ctx, db, id, SessionPatch{Cwd: "/w/" + id, StartedAt: at, LastEventAt: at}); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(`UPDATE sessions SET repo_root = ? WHERE session_id = ?`, root, id); err != nil {
			t.Fatal(err)
		}
	}
	add("old", "/r/old", 100)
	add("x1", "/r/x", 1000)
	add("x2", "/r/x", 3000)
	add("y", "/r/y", 2000)
	add("loose", "", 4000)
	got, err := RecentRepos(ctx, db, 500, 8)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0] != (RecentRepo{Root: "/r/x", SessionID: "x2", LastAt: 3000}) || got[1].Root != "/r/y" {
		t.Fatalf("repos = %+v", got)
	}
	if got, _ := RecentRepos(ctx, db, 500, 1); len(got) != 1 {
		t.Fatalf("limit: %+v", got)
	}
}
