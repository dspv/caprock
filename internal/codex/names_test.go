package codex

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/rollup"
	"github.com/dspv/caprock/internal/store"
)

const fixtureID = "01a075d9-2b63-7200-b3e2-bfeac9416f15"

// writeState creates a Codex thread index beside the harness's sessions dir.
func writeState(t *testing.T, path string, rows map[string][2]string) {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', first_user_message TEXT NOT NULL DEFAULT '', name TEXT)`); err != nil {
		t.Fatal(err)
	}
	for id, r := range rows {
		if _, err := db.Exec(`INSERT OR REPLACE INTO threads(id, name, first_user_message, title) VALUES(?, NULLIF(?, ''), ?, ?)`, id, r[0], r[1], r[1]); err != nil {
			t.Fatal(err)
		}
	}
}

// Codex names its threads in its own index; the imported session carries the
// name, and the first message is kept for when there is no name (FB-035).
func TestIngestNamesSessionsFromTheThreadIndex(t *testing.T) {
	h := newHarness(t)
	home := filepath.Dir(h.dir)
	// An older schema generation must not be the one read.
	writeState(t, filepath.Join(home, "state_3.sqlite"), map[string][2]string{fixtureID: {"stale name", ""}})
	state := filepath.Join(home, "state_5.sqlite")
	writeState(t, state, map[string][2]string{fixtureID: {"", "проверь даты без двух статей"}})
	if got := StateDB(h.dir); got != state {
		t.Fatalf("StateDB = %q, want %q", got, state)
	}
	h.put()
	h.poll()
	s, err := store.GetSession(context.Background(), h.out, fixtureID)
	if err != nil {
		t.Fatal(err)
	}
	if s.Title != "" || s.Prompt != "проверь даты без двух статей" {
		t.Fatalf("unnamed thread: title=%q prompt=%q", s.Title, s.Prompt)
	}

	// Codex names the thread later; the next poll picks it up.
	writeState(t, state, map[string][2]string{fixtureID: {"Проверь даты без двух статей", "проверь даты без двух статей"}})
	future := time.Now().Add(time.Minute)
	_ = os.Chtimes(state, future, future)
	h.poll()
	if s, _ = store.GetSession(context.Background(), h.out, fixtureID); s.Title != "Проверь даты без двух статей" {
		t.Fatalf("title = %q", s.Title)
	}
}

func TestStateDBIsEmptyWithoutCodex(t *testing.T) {
	if got := StateDB(filepath.Join(t.TempDir(), "sessions")); got != "" {
		t.Fatalf("StateDB = %q", got)
	}
}

// A turn stored before its model could be read is repriced once it can be —
// and the session and daily totals move with it, rather than the event alone.
func TestRepriceMovesTheTotalsWithTheEvent(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	at := time.Date(2026, 9, 20, 10, 0, 0, 0, time.Local)
	ev := event.Event{Ts: at, SessionID: "cx", Source: event.SourceCodex, Kind: event.KindTurnAssistant, Key: "k1",
		Tokens: &event.TokenDelta{In: 1_000_000, Out: 1_000_000}}
	if _, err := h.in.rec.Record(ctx, &ev, rollup.SessionInfo{Cwd: "/Users/dev/proj", Agent: Agent}); err != nil {
		t.Fatal(err)
	}
	if err := h.in.repriceSession(ctx, &Session{ID: "cx", Model: "gpt-5-codex", Cwd: "/Users/dev/proj"}); err != nil {
		t.Fatal(err)
	}
	var evCost, sessCost, dayCost float64
	var unnamed, named int64
	q := func(query string, dst ...any) {
		t.Helper()
		if err := h.out.QueryRow(query).Scan(dst...); err != nil {
			t.Fatalf("%s: %v", query, err)
		}
	}
	q(`SELECT cost_usd FROM events WHERE session_id = 'cx'`, &evCost)
	q(`SELECT cost_usd FROM session_stats WHERE session_id = 'cx'`, &sessCost)
	q(`SELECT COALESCE(SUM(cost_usd),0), COALESCE(SUM(tokens_total),0) FROM daily_stats WHERE model = 'gpt-5-codex'`, &dayCost, &named)
	q(`SELECT COALESCE(SUM(tokens_total),0) FROM daily_stats WHERE model = ''`, &unnamed)
	// gpt-5-codex: $1.25 in + $10 out per 1M.
	if evCost != 11.25 || sessCost != evCost || dayCost != evCost {
		t.Fatalf("event %v, session %v, day %v — want all 11.25", evCost, sessCost, dayCost)
	}
	if named != 2_000_000 || unnamed != 0 {
		t.Fatalf("day tokens: named %d, unnamed %d", named, unnamed)
	}
}
