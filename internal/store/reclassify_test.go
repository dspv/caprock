package store

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
)

// The 0021 statement, run against rows in the shape the old code wrote. The
// migration file is the source: reading it here means the test exercises the
// SQL that will actually run, not a copy of it that can drift from it.
func migration21(t *testing.T, s *Store) {
	t.Helper()
	b, err := migrationFS.ReadFile("migrations/0021_reclassify_clear_events.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.ExecContext(context.Background(), string(b)); err != nil {
		t.Fatal(err)
	}
}

// insertLegacy writes a row the way the pre-0.52.1 code did: every continuing
// SessionEnd reason stored as context.compact, with the hook payload verbatim.
func insertLegacy(t *testing.T, s *Store, id string, payload map[string]any) {
	t.Helper()
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	ev := &event.Event{
		SessionID: id,
		Source:    event.SourceHook,
		Kind:      event.KindContextCompact,
		Ts:        time.UnixMilli(1_000),
		Payload:   raw,
	}
	if _, err := InsertEvent(context.Background(), s.db, ev); err != nil {
		t.Fatal(err)
	}
}

func kindOf(t *testing.T, s *Store, id string) string {
	t.Helper()
	var k string
	if err := s.db.QueryRowContext(context.Background(),
		`SELECT kind FROM events WHERE session_id = ?`, id).Scan(&k); err != nil {
		t.Fatal(err)
	}
	return k
}

// Every continuing SessionEnd was stored under the compact's kind, so the
// dashboard narrated "compacting context" at sessions that had merely been
// cleared. On the owner's database all 18 such rows were the *last* event of
// their session — which is the phrase the session card shows.
//
// The rewrite reads the answer out of `payload`, which is stored verbatim and
// already names the hook that produced the row. It does not guess.
func TestReclassifiesOnlyTheHooksThatWereMislabelled(t *testing.T) {
	s := openTest(t)
	for _, tc := range []struct {
		name    string
		payload map[string]any
		want    string
	}{
		{"clear", map[string]any{"hook_event_name": "SessionEnd", "reason": "clear"}, string(event.KindContextClear)},
		{"escape", map[string]any{"hook_event_name": "SessionEnd", "reason": "prompt_input_exit"}, string(event.KindSessionContinue)},
		{"other", map[string]any{"hook_event_name": "SessionEnd", "reason": "other"}, string(event.KindSessionContinue)},
		// A real compaction. Its kind was correct all along and must survive:
		// this is the row the migration could most easily destroy.
		{"real-compact", map[string]any{"hook_event_name": "PreCompact", "trigger": "auto"}, string(event.KindContextCompact)},
	} {
		insertLegacy(t, s, tc.name, tc.payload)
	}
	migration21(t, s)
	for _, tc := range []struct{ id, want string }{
		{"clear", string(event.KindContextClear)},
		{"escape", string(event.KindSessionContinue)},
		{"other", string(event.KindSessionContinue)},
		{"real-compact", string(event.KindContextCompact)},
	} {
		if got := kindOf(t, s, tc.id); got != tc.want {
			t.Errorf("%s: kind %q, want %q", tc.id, got, tc.want)
		}
	}
}

// Running it twice must not move a row a second time. A migration that is not
// idempotent is one that cannot be safely retried after a kill mid-apply.
func TestReclassifyIsIdempotent(t *testing.T) {
	s := openTest(t)
	insertLegacy(t, s, "clear", map[string]any{"hook_event_name": "SessionEnd", "reason": "clear"})
	insertLegacy(t, s, "real-compact", map[string]any{"hook_event_name": "PreCompact", "trigger": "auto"})
	migration21(t, s)
	migration21(t, s)
	if got := kindOf(t, s, "clear"); got != string(event.KindContextClear) {
		t.Errorf("after two runs: %q", got)
	}
	if got := kindOf(t, s, "real-compact"); got != string(event.KindContextCompact) {
		t.Errorf("a real compaction was rewritten: %q", got)
	}
}

// The rows being rewritten carry no money and no tokens — cost comes from
// turn.assistant — so the migration cannot change what any screen says was
// spent. Rule 6: a figure must never move because a label was corrected.
func TestReclassifyMovesNoMoney(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	insertLegacy(t, s, "clear", map[string]any{"hook_event_name": "SessionEnd", "reason": "clear"})
	cost := 12.5
	if _, err := InsertEvent(ctx, s.db, &event.Event{
		SessionID: "paid", Source: event.SourceTranscript, Kind: event.KindTurnAssistant,
		Ts: time.UnixMilli(2_000), Model: "claude-opus-5", Key: "msg:m1",
		Tokens: &event.TokenDelta{In: 10, Out: 20}, CostUSD: &cost,
	}); err != nil {
		t.Fatal(err)
	}
	var before float64
	if err := s.db.QueryRowContext(ctx, `SELECT COALESCE(SUM(cost_usd),0) FROM events`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	migration21(t, s)
	var after float64
	if err := s.db.QueryRowContext(ctx, `SELECT COALESCE(SUM(cost_usd),0) FROM events`).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if before != after {
		t.Fatalf("total cost moved from %v to %v", before, after)
	}
}
