package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
)

func TestEventsMoveInTheBackground(t *testing.T) {
	ctx := context.Background()
	path, raw := openAtSchema(t, 72)
	for _, stmt := range []string{
		`INSERT INTO sessions(session_id, started_at, last_event_at, status) VALUES ('a', 1, 750, 'ended'), ('b', 751, 1500, 'ended')`,
		`INSERT INTO session_gen(session_id, gen) VALUES ('a', 5)`,
		// More rows than the migration moves itself: a's are the older half.
		`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1500)
		 INSERT INTO events(id, ts, session_id, source, kind, payload, key)
		   SELECT i, i, CASE WHEN i <= 750 THEN 'a' ELSE 'b' END, 'hook', 'turn.user', '{}', 'k' || i FROM n`,
		`INSERT INTO tool_fields(event_id, drill_key) VALUES (1, 'go test')`,
	} {
		if _, err := raw.Exec(stmt); err != nil {
			t.Fatal(err)
		}
	}
	_ = raw.Close()

	s, err := Open(ctx, path, nil)
	if err != nil {
		t.Fatal(err)
	}
	count := func(q string) int {
		t.Helper()
		var n int
		if err := s.DB().QueryRow(q).Scan(&n); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
		return n
	}
	gen := func() int { return count(`SELECT gen FROM session_gen WHERE session_id = 'a'`) }
	if !s.Moving() || count(`SELECT COUNT(*) FROM events`) != 1000 || count(`SELECT MIN(id) FROM events`) != 501 {
		t.Fatalf("after the migration: moving %v, %d events from id %d, want the newest 1,000 moved",
			s.Moving(), count(`SELECT COUNT(*) FROM events`), count(`SELECT MIN(id) FROM events`))
	}
	if moved, total, err := s.MoveProgress(ctx); err != nil || moved != 1000 || total != 1500 {
		t.Fatalf("progress %d of %d (%v), want 1000 of 1500", moved, total, err)
	}

	// While a's rows wait, their keys are taken, and a new event comes after
	// every old id.
	ev := func(key string) *event.Event {
		return &event.Event{SessionID: "a", Source: event.SourceHook, Kind: event.KindTurnUser, Key: key,
			Payload: json.RawMessage(`{}`), Ts: time.UnixMilli(2000)}
	}
	if _, err := InsertEvent(ctx, s.DB(), ev("k1")); !errors.Is(err, ErrDuplicate) {
		t.Fatalf("a key still waiting to move inserted again: %v", err)
	}
	if id, err := InsertEvent(ctx, s.DB(), ev("new")); err != nil || id != 1501 {
		t.Fatalf("new event: id %d (%v), want 1501", id, err)
	}

	// One step, then a restart: the move goes on where it stopped, and
	// every cache keyed on events sees the rows come in.
	v0, _ := EventsVersion(ctx, s.DB())
	g0 := gen()
	if n, done, err := s.MoveEventsStep(ctx, 100); err != nil || done || n != 100 {
		t.Fatalf("one step: %d moved, done %v, %v", n, done, err)
	}
	if v1, _ := EventsVersion(ctx, s.DB()); v1 == v0 {
		t.Fatal("EventsVersion did not move with the rows")
	}
	if gen() == g0 {
		t.Fatal("session_gen of a moved session did not move")
	}
	_ = s.Close()
	if s, err = Open(ctx, path, nil); err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if !s.Moving() {
		t.Fatal("the move did not resume after a restart")
	}
	if _, err := s.MoveEvents(ctx, 150, 0); err != nil {
		t.Fatal(err)
	}
	if s.Moving() {
		t.Fatal("still moving once every row is in")
	}

	rows, err := s.DB().Query(`SELECT e.id, e.ts, s.session_id, e.key FROM events e JOIN sessions s USING (sid) WHERE e.id <= 1500 ORDER BY e.id`)
	if err != nil {
		t.Fatal(err)
	}
	want := int64(1)
	for rows.Next() {
		var id, ts int64
		var sess, key string
		if err := rows.Scan(&id, &ts, &sess, &key); err != nil {
			t.Fatal(err)
		}
		owner := "a"
		if want > 750 {
			owner = "b"
		}
		if id != want || ts != want || sess != owner || key != fmt.Sprintf("k%d", want) {
			t.Fatalf("event %d: id %d ts %d session %s key %s", want, id, ts, sess, key)
		}
		want++
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	_ = rows.Close()
	if want != 1501 {
		t.Fatalf("%d old events after the move, want 1500", want-1)
	}
	if n := count(`SELECT COUNT(*) FROM sqlite_master WHERE name IN ('events_legacy', 'events_legacy_dedupe')`); n != 0 {
		t.Fatalf("%d objects of the move left behind", n)
	}
	if n := count(`SELECT COUNT(*) FROM meta WHERE k IN ('events_move_total', 'events_moved')`); n != 0 {
		t.Fatalf("%d progress keys left behind", n)
	}
	if n := count(`SELECT COUNT(*) FROM tool_fields WHERE event_id = 1`); n != 1 {
		t.Fatal("a moved tool call lost its fields")
	}
	if err := s.DB().QueryRow(`SELECT 1 FROM pragma_foreign_key_check`).Scan(new(int)); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("a foreign key is broken after the move: %v", err)
	}
	if _, err := InsertEvent(ctx, s.DB(), ev("k1")); !errors.Is(err, ErrDuplicate) {
		t.Fatalf("a moved key inserted again: %v", err)
	}
	if moved, total, err := s.MoveProgress(ctx); err != nil || moved != 0 || total != 0 {
		t.Fatalf("progress after the move: %d of %d (%v)", moved, total, err)
	}
}

func TestANewDatabaseHasNothingToMove(t *testing.T) {
	s := openTest(t)
	if s.Moving() {
		t.Fatal("a new database is moving")
	}
	var n int
	if err := s.DB().QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE name IN ('events_legacy', 'events_legacy_dedupe')`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("%d objects of the move on a new database (%v)", n, err)
	}
}
