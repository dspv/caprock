package store

import (
	"context"
	"fmt"
	"reflect"
	"testing"
	"time"
)

// A range started from parts_kept and brought up to date is the range read
// afresh: after more turns in sessions it holds, a new session, a session's
// events deleted, and a restart (a new cache) in between.
func TestKeptPartsEqualAFreshRead(t *testing.T) {
	f := newPartsFixture(t)
	f.fill()
	ctx := context.Background()
	db := f.s.DB()
	at := f.now
	clock := func() time.Time { return at }
	midnight := time.Date(2026, 11, 20, 0, 0, 0, 0, time.UTC).UnixMilli()
	ranges := []int64{0, midnight}

	run := func(version string) *PartsCache {
		c := NewPartsCache()
		c.SetClock(clock)
		c.SetThrottle(0)
		c.Keep(version)
		return c
	}
	exact := func(c *PartsCache, step string) {
		t.Helper()
		for _, from := range ranges {
			want, err := legacySummarizeSparkFor(ctx, db, from, SparkSpec{}, "")
			if err != nil {
				t.Fatal(err)
			}
			got, _, err := c.Summary(ctx, db, from, SparkSpec{}, "")
			if err != nil {
				t.Fatal(err)
			}
			sameSummary(t, fmt.Sprintf("%s, from %d", step, from), want, got)
			// The tools as a range read afresh orders them (equal counts
			// tie in the parts' order, not ToolDistribution's).
			wantTools, err := NewPartsCache().Tools(ctx, db, from, 40)
			if err != nil {
				t.Fatal(err)
			}
			gotTools, err := c.Tools(ctx, db, from, 40)
			if err != nil {
				t.Fatal(err)
			}
			sameSummary(t, fmt.Sprintf("%s tools, from %d", step, from), wantTools, gotTools)
		}
		c.WaitSaved()
	}
	counts := func(c *PartsCache, from int64) (loaded, full, partial int) {
		kp := c.ranges[from]
		return kp.loaded, kp.full, kp.partial
	}

	first := run("v1")
	exact(first, "first run")
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM parts_kept`).Scan(&n); err != nil || n != len(ranges) {
		t.Fatalf("parts_kept rows = %d (%v), want %d", n, err, len(ranges))
	}

	// While no daemon runs: more turns, a new session, one session's events gone.
	at = at.Add(time.Minute)
	f.turn("today-a", "claude", 0, f.now.Add(-time.Minute))
	f.session("late", "codex", 1, f.now.Add(-30*time.Minute), 4)
	if _, err := db.Exec(`DELETE FROM events WHERE sid = (SELECT sid FROM sessions WHERE session_id = 's03')`); err != nil {
		t.Fatal(err)
	}

	second := run("v1")
	exact(second, "after a restart")
	for _, from := range ranges {
		if loaded, full, _ := counts(second, from); loaded != 1 || full != 0 {
			t.Fatalf("from %d: loaded %d, full reads %d; want the kept row used and no full read", from, loaded, full)
		}
	}

	// Moves after the start are read as in any run.
	at = at.Add(time.Minute)
	f.turn("late", "codex", 1, f.now.Add(-time.Minute))
	exact(second, "a move after the restart")

	// Another build's row, or one older than partsRebuild, is not used.
	other := run("v2")
	exact(other, "another build")
	if loaded, full, _ := counts(other, 0); loaded != 0 || full != 1 {
		t.Fatalf("another build: loaded %d, full %d; want 0 and 1", loaded, full)
	}
	at = at.Add(partsRebuild + time.Minute)
	old := run("v2")
	exact(old, "a row past partsRebuild")
	if loaded, full, _ := counts(old, 0); loaded != 0 || full != 1 {
		t.Fatalf("an old row: loaded %d, full %d; want 0 and 1", loaded, full)
	}
}

// The stored form gives back the parts and mark it was made from.
func TestKeptPartsRoundTrip(t *testing.T) {
	f := newPartsFixture(t)
	f.fill()
	ctx := context.Background()
	db := f.s.DB()
	rp, err := readParts(ctx, db, 0, 0, 0, partsScope{all: true})
	if err != nil {
		t.Fatal(err)
	}
	mark, err := ReadEventsMark(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	blob, err := encodeKept(rp, mark)
	if err != nil {
		t.Fatal(err)
	}
	gotRP, gotMark, err := decodeKept(blob)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(rp, gotRP) {
		t.Fatal("parts changed through the stored form")
	}
	if !gotMark.Same(mark) || gotMark.maxID != mark.maxID || gotMark.moved != mark.moved {
		t.Fatal("mark changed through the stored form")
	}
	if len(rp.sids) == 0 {
		t.Fatal("fixture read no parts")
	}
}
