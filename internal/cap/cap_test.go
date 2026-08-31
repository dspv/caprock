package cap

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

// This feature stops someone's work, so what is tested is when it refuses to.

type fakeSig struct {
	mu      sync.Mutex
	running []string
	// owned decides which ids PauseOwned will act on; anything else is refused,
	// which is how rule 7 is enforced in the real manager.
	owned  map[string]bool
	paused []string
	err    error
}

func (f *fakeSig) OwnedRunning() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.running...)
}

func (f *fakeSig) PauseOwned(id string) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return false, f.err
	}
	if !f.owned[id] {
		return false, nil
	}
	f.paused = append(f.paused, id)
	return true, nil
}

func newGuard(limit, spend float64, sig *fakeSig, now time.Time) *Guard {
	return &Guard{
		Settings: func() Settings { return Settings{LimitUSD: limit} },
		Spend:    func(context.Context) (float64, error) { return spend, nil },
		Sig:      sig,
		Now:      func() time.Time { return now },
	}
}

var noon = time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC)

func TestCapPausesOnlyWhenTheDayCrossesTheLimit(t *testing.T) {
	for _, tc := range []struct {
		name         string
		limit, spend float64
		want         bool
	}{
		{"under the limit", 100, 99.99, false},
		{"exactly at it", 100, 100, true},
		{"over it", 100, 140, true},
		{"no limit set", 0, 5000, false},
		{"a negative limit is off, not instant", -1, 5000, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			sig := &fakeSig{running: []string{"a"}, owned: map[string]bool{"a": true}}
			g := newGuard(tc.limit, tc.spend, sig, noon)
			if got := g.Check(context.Background()); got != tc.want {
				t.Errorf("fired=%v, want %v", got, tc.want)
			}
			if tc.want && len(sig.paused) == 0 {
				t.Error("fired but paused nothing")
			}
			if !tc.want && len(sig.paused) > 0 {
				t.Errorf("paused %v without crossing the limit", sig.paused)
			}
		})
	}
}

func TestCapNeverTouchesASessionCaprockDidNotStart(t *testing.T) {
	// Rule 7, and the reason anyone lets this daemon near their machine. A
	// session started by hand is watched and never signalled, however much it
	// is costing.
	sig := &fakeSig{
		running: []string{"ours", "theirs"},
		owned:   map[string]bool{"ours": true},
	}
	g := newGuard(100, 500, sig, noon)
	if !g.Check(context.Background()) {
		t.Fatal("did not fire")
	}
	for _, id := range sig.paused {
		if id == "theirs" {
			t.Fatal("paused a session Caprock did not start")
		}
	}
	if len(sig.paused) != 1 || sig.paused[0] != "ours" {
		t.Errorf("paused %v, want only [ours]", sig.paused)
	}
}

func TestCapFiresOnceADay(t *testing.T) {
	// Without this, every priced turn after the threshold pauses again — so a
	// session resumed by hand is re-paused within seconds and the product
	// reads as fighting its owner.
	sig := &fakeSig{running: []string{"a"}, owned: map[string]bool{"a": true}}
	g := newGuard(100, 500, sig, noon)

	if !g.Check(context.Background()) {
		t.Fatal("first check did not fire")
	}
	for i := 0; i < 5; i++ {
		if g.Check(context.Background()) {
			t.Fatal("fired again on the same day")
		}
	}
	if len(sig.paused) != 1 {
		t.Errorf("paused %d times, want once", len(sig.paused))
	}

	// The next day is a new budget.
	g.Now = func() time.Time { return noon.Add(24 * time.Hour) }
	if !g.Check(context.Background()) {
		t.Error("did not fire on the following day")
	}
}

func TestCapFailsOpenWhenTheSpendCannotBeRead(t *testing.T) {
	// A missed pause costs money; a spurious one stops work that was fine. The
	// second is the one people do not forgive, so an unreadable spend must not
	// be guessed at.
	sig := &fakeSig{running: []string{"a"}, owned: map[string]bool{"a": true}}
	g := newGuard(100, 0, sig, noon)
	g.Spend = func(context.Context) (float64, error) { return 0, errors.New("database busy") }

	if g.Check(context.Background()) {
		t.Error("fired without being able to read the spend")
	}
	if len(sig.paused) > 0 {
		t.Errorf("paused %v on an unreadable spend", sig.paused)
	}
}

func TestCapKeepsGoingWhenOneSessionWillNotPause(t *testing.T) {
	// One stuck process must not leave the others running.
	sig := &fakeSig{running: []string{"a", "b"}, owned: map[string]bool{"a": true, "b": true}}
	g := newGuard(100, 500, sig, noon)
	calls := 0
	inner := sig.PauseOwned
	g.Sig = &funcSig{
		running: func() []string { return sig.OwnedRunning() },
		pause: func(id string) (bool, error) {
			calls++
			if id == "a" {
				return false, errors.New("no such process")
			}
			return inner(id)
		},
	}
	if !g.Check(context.Background()) {
		t.Fatal("did not fire")
	}
	if calls != 2 {
		t.Errorf("attempted %d sessions, want both", calls)
	}
	if len(sig.paused) != 1 || sig.paused[0] != "b" {
		t.Errorf("paused %v, want the one that could be paused", sig.paused)
	}
}

func TestCapDoesNotDoubleFireUnderConcurrentTurns(t *testing.T) {
	// Two turns crossing the threshold together must not both pause: the
	// day is claimed before any signal is sent.
	sig := &fakeSig{running: []string{"a"}, owned: map[string]bool{"a": true}}
	g := newGuard(100, 500, sig, noon)

	var wg sync.WaitGroup
	fired := make(chan bool, 20)
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); fired <- g.Check(context.Background()) }()
	}
	wg.Wait()
	close(fired)

	n := 0
	for f := range fired {
		if f {
			n++
		}
	}
	if n != 1 {
		t.Errorf("fired %d times concurrently, want exactly once", n)
	}
	if len(sig.paused) != 1 {
		t.Errorf("paused %d times, want once", len(sig.paused))
	}
}

func TestResetLetsWorkContinueAfterTheLimitIsRaised(t *testing.T) {
	// Raising the limit after a pause should release it, not leave the cap
	// latched until midnight.
	sig := &fakeSig{running: []string{"a"}, owned: map[string]bool{"a": true}}
	g := newGuard(100, 150, sig, noon)
	if !g.Check(context.Background()) {
		t.Fatal("did not fire")
	}
	g.Reset()
	g.Settings = func() Settings { return Settings{LimitUSD: 500} }
	if g.Check(context.Background()) {
		t.Error("fired again after the limit was raised above the spend")
	}
}

func TestSuggestUsesTheirOwnHistoryAndRounds(t *testing.T) {
	// A blank dollar field gets one of two answers: a number so high it never
	// fires, or one so low it fires on a normal Tuesday. Their own median day
	// is neither, and it is a fact rather than a guess (rule 6).
	for _, tc := range []struct{ median, want float64 }{
		{0, 0},     // nothing measured yet — offer nothing
		{-5, 0},    // never negative
		{3.2, 6},   // small days round to the dollar
		{40, 80},   // 2x, to the nearest 5
		{88, 180},  // 176 crosses 100, so it rounds to 10
		{150, 300}, // large days round to 10
	} {
		if got := Suggest(tc.median); got != tc.want {
			t.Errorf("Suggest(%.2f) = %.2f, want %.2f", tc.median, got, tc.want)
		}
	}
}

// funcSig is a Signaller built from two closures, for the cases where the
// fake's fixed behaviour is not the thing under test.
type funcSig struct {
	running func() []string
	pause   func(string) (bool, error)
}

func (f *funcSig) OwnedRunning() []string             { return f.running() }
func (f *funcSig) PauseOwned(id string) (bool, error) { return f.pause(id) }
