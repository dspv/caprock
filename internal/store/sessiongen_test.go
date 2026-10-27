package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
)

// TestEventsGenMovesOnEveryChange: the sessions list trusts its cache while a
// session's EventsGen stands still (F14), so every insert, update and delete
// of a session's events must move it, and only that session's, whichever code
// writes them; and a value read later is never Older than one read before.
func TestEventsGenMovesOnEveryChange(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	db := s.DB()
	read := func(id string) EventsGen {
		t.Helper()
		g, err := ReadEventsGen(ctx, db, id)
		if err != nil {
			t.Fatal(err)
		}
		return g
	}
	if g := read("a"); g != (EventsGen{}) {
		t.Fatalf("no events yet: %+v, want zero", g)
	}
	now := time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC)
	n := 0
	insert := func(id string, ts time.Time) {
		t.Helper()
		n++
		ev := &event.Event{SessionID: id, Source: event.SourceHook, Kind: event.KindToolPre, Tool: "Bash",
			Key: fmt.Sprint("k", n), Ts: ts, Payload: json.RawMessage(`{}`)}
		if _, err := InsertEvent(ctx, db, ev); err != nil {
			t.Fatal(err)
		}
	}
	a, b := read("a"), read("b")
	step := func(name string, change func(), wantA, wantB bool) {
		t.Helper()
		change()
		na, nb := read("a"), read("b")
		if (na != a) != wantA || (nb != b) != wantB || na.Older(a) || nb.Older(b) {
			t.Fatalf("%s: a %+v->%+v b %+v->%+v, want moved a=%v b=%v", name, a, na, b, nb, wantA, wantB)
		}
		a, b = na, nb
	}
	exec := func(sql string) func() {
		return func() {
			if _, err := db.ExecContext(ctx, sql); err != nil {
				t.Fatal(err)
			}
		}
	}
	step("insert a", func() { insert("a", now) }, true, false)
	step("insert a again", func() { insert("a", now.Add(time.Second)) }, true, false)
	step("insert b", func() { insert("b", now) }, false, true)
	// A transcript line older than everything stored still moves it.
	step("insert a out of order", func() { insert("a", now.Add(-time.Hour)) }, true, false)
	step("duplicate is no change", func() {
		ev := &event.Event{SessionID: "a", Source: event.SourceHook, Kind: event.KindToolPre, Key: "k1", Ts: now, Payload: json.RawMessage(`{}`)}
		if _, err := InsertEvent(ctx, db, ev); !errors.Is(err, ErrDuplicate) {
			t.Fatalf("want ErrDuplicate, got %v", err)
		}
	}, false, false)
	step("update", exec(`UPDATE events SET payload = '{"x":1}' WHERE sid = (SELECT sid FROM sessions WHERE session_id = 'a')`), true, false)
	step("move to another session", exec(`UPDATE events SET sid = (SELECT sid FROM sessions WHERE session_id = 'b') WHERE id = (SELECT MIN(id) FROM events WHERE sid = (SELECT sid FROM sessions WHERE session_id = 'a'))`), true, true)
	// Deleting the newest row lowers MaxID; the generation still moves on.
	step("delete newest", exec(`DELETE FROM events WHERE id = (SELECT MAX(id) FROM events WHERE sid = (SELECT sid FROM sessions WHERE session_id = 'a'))`), true, false)
	step("delete b", exec(`DELETE FROM events WHERE sid = (SELECT sid FROM sessions WHERE session_id = 'b')`), false, true)
	step("delete the rest", exec(`DELETE FROM events`), true, false)
	// Never reset: a session seen again carries on from where it was.
	step("b re-seen", func() { insert("b", now) }, false, true)
}

// TestEventsGenTriggersExist guards the triggers against a future migration
// that rebuilds the events table: dropping a table drops its triggers, and the
// sessions list would then serve stale summaries without any test of its own
// noticing.
func TestEventsGenTriggersExist(t *testing.T) {
	s := openTest(t)
	for _, name := range []string{"events_gen_update", "events_gen_delete"} {
		var tbl string
		err := s.DB().QueryRowContext(context.Background(),
			`SELECT tbl_name FROM sqlite_master WHERE type = 'trigger' AND name = ?`, name).Scan(&tbl)
		if err != nil || tbl != "events" {
			t.Fatalf("trigger %s: table %q, err %v", name, tbl, err)
		}
	}
}
