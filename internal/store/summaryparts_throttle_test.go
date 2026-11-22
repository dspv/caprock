package store

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"
)

// Within the throttle window what moved waits and the answer says it is
// behind; past it, one read takes in every move of the window and the figures
// are exactly the ones counted afresh. A Hurry lifts the window at once.
func TestPartsCacheThrottle(t *testing.T) {
	f := newPartsFixture(t)
	f.fill()
	ctx := context.Background()
	db := f.s.DB()
	cache := NewPartsCache()
	at := f.now
	cache.now = func() time.Time { return at }
	midnight := time.Date(2026, 11, 20, 0, 0, 0, 0, time.UTC).UnixMilli()
	ranges := []int64{0, midnight}
	ask := func(q Querier, from int64) (Summary, bool) {
		t.Helper()
		c, lag := NoteLag(ctx)
		s, _, err := cache.Summary(c, q, from, SparkSpec{}, "")
		if err != nil {
			t.Fatal(err)
		}
		return s, lag.Load()
	}
	exact := func(step string) {
		t.Helper()
		for _, from := range ranges {
			want, err := legacySummarizeSparkFor(ctx, db, from, SparkSpec{}, "")
			if err != nil {
				t.Fatal(err)
			}
			got, behind := ask(db, from)
			if behind {
				t.Fatalf("%s, from %d: said behind", step, from)
			}
			sameSummary(t, fmt.Sprintf("%s, from %d", step, from), want, got)
		}
	}
	reads := func(from int64) (int, int) { kp := cache.ranges[from]; return kp.full, kp.partial }
	exact("first read")
	before := map[int64]Summary{}
	for _, from := range ranges {
		before[from], _ = ask(db, from)
	}

	// Moves inside the window: three sessions, one of them twice. The kept
	// parts are handed back as they were, behind, and no event is read.
	at = at.Add(time.Second)
	f.turn("today-a", "claude", 0, f.now.Add(-time.Minute))
	for i, id := range []string{"today-b", "s03", "today-a"} {
		at = at.Add(3 * time.Second)
		f.turn(id, "codex", 1, f.now.Add(-time.Duration(i+2)*time.Minute))
		for _, from := range ranges {
			rec := &planRecorder{Querier: db}
			got, behind := ask(rec, from)
			if !behind {
				t.Fatalf("move %d, from %d: not said behind inside the window", i, from)
			}
			sameSummary(t, fmt.Sprintf("move %d inside the window, from %d", i, from), before[from], got)
			for _, r := range rec.seen {
				if strings.Contains(r.sql, "idx_events_attr_work") || strings.Contains(r.sql, "JOIN events") {
					t.Fatalf("events read inside the window: %s", r.sql)
				}
			}
		}
	}
	for _, from := range ranges {
		if full, partial := reads(from); full != 1 || partial != 0 {
			t.Fatalf("from %d inside the window: %d full and %d partial reads, want 1 and 0", from, full, partial)
		}
	}

	// Past the window: one read of what moved, and the exact figures.
	at = f.now.Add(partsThrottle + time.Second)
	exact("past the window")
	for _, from := range ranges {
		if full, partial := reads(from); full != 1 || partial != 1 {
			t.Fatalf("from %d past the window: %d full and %d partial reads, want 1 and 1", from, full, partial)
		}
	}
	// Nothing moved since: not behind, nothing read, however soon.
	exact("nothing moved")

	// A Hurry (a removal) is read on the next ask, inside the window or not.
	f.turn("s05", "claude", 0, f.now.Add(-time.Hour))
	at = at.Add(time.Second)
	if _, behind := ask(db, 0); !behind {
		t.Fatal("a move right after a read was not held back")
	}
	cache.Hurry()
	exact("after a hurry")
}

// With agents working, a move lands before every ask; the reads are bounded
// by the window, not by the moves, and the figures end exact.
func TestPartsCacheNoRefreshStorm(t *testing.T) {
	f := newPartsFixture(t)
	f.fill()
	ctx := context.Background()
	db := f.s.DB()
	cache := NewPartsCache()
	at := f.now
	cache.now = func() time.Time { return at }
	midnight := time.Date(2026, 11, 20, 0, 0, 0, 0, time.UTC).UnixMilli()
	const asks = 60 // one every two seconds: two minutes of the Now screen
	for i := range asks {
		f.turn([]string{"today-a", "today-b"}[i%2], "claude", i%2, f.now.Add(-time.Duration(asks-i)*time.Second))
		at = at.Add(2 * time.Second)
		for _, from := range []int64{0, midnight} {
			if _, _, err := cache.Summary(ctx, db, from, SparkSpec{}, ""); err != nil {
				t.Fatal(err)
			}
		}
	}
	window := 2 * time.Second * asks
	most := int(window/partsThrottle) + 1
	for _, from := range []int64{0, midnight} {
		kp := cache.ranges[from]
		if kp.full != 1 || kp.partial > most {
			t.Fatalf("from %d: %d full and %d partial reads for %d asks, want 1 and at most %d", from, kp.full, kp.partial, asks, most)
		}
	}
	at = at.Add(partsThrottle)
	for _, from := range []int64{0, midnight} {
		want, err := legacySummarizeSparkFor(ctx, db, from, SparkSpec{}, "")
		if err != nil {
			t.Fatal(err)
		}
		got, _, err := cache.Summary(ctx, db, from, SparkSpec{}, "")
		if err != nil {
			t.Fatal(err)
		}
		sameSummary(t, fmt.Sprintf("converged, from %d", from), want, got)
	}
}
