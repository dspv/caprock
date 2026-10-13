package store

import (
	"context"
	"fmt"
	"testing"
)

// The deciles are nearest-rank over the sorted samples: the first is the
// minimum, the last the maximum, the sixth the median.
func TestDecilesNearestRank(t *testing.T) {
	v := make([]float64, 0, 101)
	for i := 100; i >= 0; i-- { // unsorted on purpose
		v = append(v, float64(i))
	}
	d := deciles(v, 1)
	if d == nil || d.N != 101 || len(d.Q) != 11 {
		t.Fatalf("deciles = %+v", d)
	}
	for k, got := range d.Q {
		if want := float64(k * 10); got != want {
			t.Fatalf("q[%d] = %v, want %v", k, got, want)
		}
	}
	if one := deciles([]float64{7}, 1); one == nil || one.Q[0] != 7 || one.Q[5] != 7 || one.Q[10] != 7 {
		t.Fatalf("one sample = %+v", one)
	}
	if deciles([]float64{1, 2, 3}, 4) != nil {
		t.Fatal("below the minimum must give no distribution")
	}
	if deciles(nil, 0) != nil {
		t.Fatal("no samples must give no distribution")
	}
}

// A new user has no usual at all: nothing is better than a median of three.
func TestUsualNewUserHasNone(t *testing.T) {
	s := openTest(t)
	base := int64(1_800_000_000_000)
	for i := 0; i < 6; i++ {
		spend(t, s, "s1", base+int64(i)*60_000, 1000, 0.5)
	}
	u, err := UsualSince(context.Background(), s.db, 0, "")
	if err != nil {
		t.Fatal(err)
	}
	if u != nil {
		t.Fatalf("one session, one hour: usual = %+v, want none", u)
	}
}

// Hours with too few calls or no cost are not active; each session's hour is
// its own sample; session totals sum across hours; cache is across sessions.
func TestUsualDistributions(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	const h = int64(3_600_000)
	base := (int64(1_800_000_000_000) / h) * h
	// Ten sessions, three active hours each: hour k of session i costs
	// (i+1) dollars over five calls.
	for i := 0; i < 10; i++ {
		sid := fmt.Sprintf("s%02d", i)
		for k := 0; k < 3; k++ {
			for c := 0; c < UsualMinCalls; c++ {
				spend(t, s, sid, base+int64(k)*h+int64(c)*60_000, 100, float64(i+1)/UsualMinCalls)
			}
		}
		// A passing touch: two calls in a fourth hour. It counts toward the
		// session's total, not as an active hour.
		spend(t, s, sid, base+5*h, 100, 1)
		spend(t, s, sid, base+5*h+60_000, 100, 1)
	}
	u, err := UsualSince(ctx, s.db, 0, "")
	if err != nil {
		t.Fatal(err)
	}
	if u == nil || u.Burn == nil || u.Cost == nil || u.Tokens == nil {
		t.Fatalf("usual = %+v", u)
	}
	if u.Days != UsualDays {
		t.Fatalf("days = %d", u.Days)
	}
	if u.Burn.N != 30 {
		t.Fatalf("active session-hours = %d, want 30 (the two-call hours are not active)", u.Burn.N)
	}
	near := func(a, b float64) bool { return a-b < 1e-9 && b-a < 1e-9 }
	if !near(u.Burn.Q[0], 1) || !near(u.Burn.Q[10], 10) {
		t.Fatalf("burn min/max = %v/%v, want 1/10", u.Burn.Q[0], u.Burn.Q[10])
	}
	if u.Cost.N != 10 {
		t.Fatalf("sessions = %d, want 10", u.Cost.N)
	}
	// Session i: 3 hours of (i+1) plus the $2 touch.
	if !near(u.Cost.Q[0], 5) || !near(u.Cost.Q[10], 32) {
		t.Fatalf("session cost min/max = %v/%v, want 5/32", u.Cost.Q[0], u.Cost.Q[10])
	}
	if u.Tokens.Q[10] != float64(17*100) {
		t.Fatalf("session tokens max = %v, want 1700", u.Tokens.Q[10])
	}
	if u.Cache == nil || *u.Cache != 0 {
		t.Fatalf("cache = %v, want 0 (no cache reads)", u.Cache)
	}
	// From after every event: nothing.
	if u, err := UsualSince(ctx, s.db, base+10*h, ""); err != nil || u != nil {
		t.Fatalf("empty window: %+v, %v", u, err)
	}
}
