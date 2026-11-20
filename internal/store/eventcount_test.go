package store

import (
	"context"
	"strings"
	"testing"
	"time"
)

// The kept count is COUNT(*) after every kind of write — new rows, a new
// session, an update, a removed session — and with nothing written it reads
// no event.
func TestEventCounterFollowsEveryWrite(t *testing.T) {
	f := newPartsFixture(t)
	f.fill()
	ctx := context.Background()
	db := f.s.DB()
	var c EventCounter
	check := func(step string) {
		t.Helper()
		want, err := CountEvents(ctx, db)
		if err != nil {
			t.Fatal(err)
		}
		got, err := c.Count(ctx, db)
		if err != nil {
			t.Fatal(err)
		}
		if got != want {
			t.Fatalf("%s: counted %d, want %d", step, got, want)
		}
	}
	check("first count")
	rec := &planRecorder{Querier: db}
	if _, err := c.Count(ctx, rec); err != nil {
		t.Fatal(err)
	}
	for _, r := range rec.seen {
		if strings.Contains(r.sql, "COUNT(*) FROM events") {
			t.Fatalf("nothing was written, yet events were counted: %s", r.sql)
		}
	}
	f.turn("s04", "hermes", 1, f.now)
	check("a new turn")
	f.session("fresh", "claude", 0, f.now, 2)
	check("a new session")
	if _, err := db.ExecContext(ctx, `DELETE FROM events WHERE id IN (SELECT id FROM events WHERE sid = (SELECT sid FROM sessions WHERE session_id = 's06') LIMIT 3)`); err != nil {
		t.Fatal(err)
	}
	check("rows deleted")
	if _, err := RemoveSession(ctx, db, RemovalCandidate{SessionID: "s09"}, time.UTC, nowMs()); err != nil {
		t.Fatal(err)
	}
	check("a removed session")
	if _, err := PruneEventsBefore(ctx, db, f.now.Add(-5*24*time.Hour).UnixMilli()); err != nil {
		t.Fatal(err)
	}
	check("retention")
}
