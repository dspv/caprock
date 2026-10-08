package cap

import (
	"context"
	"errors"
	"reflect"
	"sort"
	"sync"
	"testing"
	"time"
)

// The plan-window stop pauses someone's work on figures it did not measure
// itself, so most of these are about when it must not.

type winSig struct {
	mu sync.Mutex
	// kinds is every running session Caprock owns, by agent.
	kinds map[string]string
	// hand is a session the user started in their own terminal: running, never
	// owned. PauseOwned refuses it, as the real manager does.
	hand    string
	paused  []string
	resumed []string
	ended   map[string]bool
}

func (f *winSig) OwnedRunningKind(kind string) []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for id, k := range f.kinds {
		if k == kind && !f.ended[id] {
			out = append(out, id)
		}
	}
	sort.Strings(out)
	return out
}

func (f *winSig) PauseOwned(id string) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, ok := f.kinds[id]; !ok || f.ended[id] {
		return false, nil
	}
	f.paused = append(f.paused, id)
	return true, nil
}

func (f *winSig) ResumeOwned(id string) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, ok := f.kinds[id]; !ok || f.ended[id] {
		return false, nil
	}
	f.resumed = append(f.resumed, id)
	return true, nil
}

type winClock struct{ t time.Time }

func (c *winClock) now() time.Time { return c.t }

var t0 = time.Date(2026, 10, 9, 12, 0, 0, 0, time.UTC)

type winFixture struct {
	g      *WindowGuard
	sig    *winSig
	clock  *winClock
	set    WindowSettings
	ws     []Window
	events []WindowEvent
	saved  []WindowState
}

func newWin(t *testing.T) *winFixture {
	t.Helper()
	f := &winFixture{
		sig:   &winSig{kinds: map[string]string{"a": "claude", "b": "claude", "codex1": "codex"}, hand: "mine", ended: map[string]bool{}},
		clock: &winClock{t: t0},
		set:   WindowSettings{Pct: 90, Licensed: true},
	}
	f.g = &WindowGuard{
		Settings: func() WindowSettings { return f.set },
		Windows:  func(context.Context) ([]Window, error) { return f.ws, nil },
		Sig:      f.sig,
		Notify:   func(_ context.Context, ev WindowEvent) { f.events = append(f.events, ev) },
		Save:     func(_ context.Context, st WindowState) error { f.saved = append(f.saved, st); return nil },
		Now:      f.clock.now,
	}
	return f
}

// fiveHour is a five-hour window at pct, observed just now, resetting in 2h.
func (f *winFixture) fiveHour(pct float64) Window {
	return Window{Name: WindowFiveHour, UsedPct: pct, ResetsAt: f.clock.t.Add(2 * time.Hour), ObservedAt: f.clock.t}
}

func TestWindowStopPausesAtTheShareAndNotBelow(t *testing.T) {
	for _, tc := range []struct {
		name string
		used float64
		pct  int
		want bool
	}{
		{"below", 89.9, 90, false},
		{"exactly at", 90, 90, true},
		{"over", 97, 90, true},
		{"off", 99, 0, false},
		{"a lower share", 81, 80, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newWin(t)
			f.set.Pct = tc.pct
			f.ws = []Window{f.fiveHour(tc.used)}
			if got := f.g.Check(context.Background()); got != tc.want {
				t.Fatalf("fired=%v, want %v", got, tc.want)
			}
			if tc.want && !reflect.DeepEqual(f.sig.paused, []string{"a", "b"}) {
				t.Errorf("paused %v, want the two Claude Code sessions Caprock started", f.sig.paused)
			}
			if !tc.want && len(f.sig.paused) > 0 {
				t.Errorf("paused %v below the share", f.sig.paused)
			}
		})
	}
}

func TestWindowStopNeverTouchesAHandStartedSessionOrAnotherAgent(t *testing.T) {
	f := newWin(t)
	f.ws = []Window{f.fiveHour(95)}
	f.g.Check(context.Background())
	for _, id := range f.sig.paused {
		if id == f.sig.hand {
			t.Fatal("paused a session the user started by hand (rule 7)")
		}
		if id == "codex1" {
			t.Fatal("paused a Codex session for Claude's plan window")
		}
	}
	if len(f.events) != 1 || !reflect.DeepEqual(f.events[0].Sessions, []string{"a", "b"}) {
		t.Fatalf("notice %+v, want one naming a and b", f.events)
	}
	ev := f.events[0]
	if ev.Kind != "paused" || ev.Window != WindowFiveHour || ev.ResumeAt != t0.Add(2*time.Hour).Unix() || ev.Pct != 90 {
		t.Errorf("notice %+v does not say which window, at what share, or when it resets", ev)
	}
}

func TestWindowStopRefusesStaleFigures(t *testing.T) {
	for _, tc := range []struct {
		name string
		w    func(f *winFixture) Window
	}{
		{"observed too long ago", func(f *winFixture) Window {
			w := f.fiveHour(99)
			w.ObservedAt = f.clock.t.Add(-FreshFor - time.Second)
			return w
		}},
		{"never observed", func(f *winFixture) Window {
			w := f.fiveHour(99)
			w.ObservedAt = time.Time{}
			return w
		}},
		{"reset already passed", func(f *winFixture) Window {
			w := f.fiveHour(99)
			w.ResetsAt = f.clock.t.Add(-time.Minute)
			return w
		}},
		{"reset implausibly far ahead", func(f *winFixture) Window {
			w := f.fiveHour(99)
			w.ResetsAt = f.clock.t.Add(30 * 24 * time.Hour)
			return w
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newWin(t)
			f.ws = []Window{tc.w(f)}
			if f.g.Check(context.Background()) || len(f.sig.paused) > 0 {
				t.Fatalf("paused %v on a stale figure", f.sig.paused)
			}
			if ok, why := Fresh(f.ws[0], f.clock.t); ok || why == "" {
				t.Errorf("Fresh = %v, %q; want false with a reason the dashboard can show", ok, why)
			}
		})
	}
}

func TestWindowStopUnlicensedIsAlertOnly(t *testing.T) {
	f := newWin(t)
	f.set.Licensed = false
	f.ws = []Window{f.fiveHour(99)}
	if f.g.Check(context.Background()) || len(f.sig.paused) > 0 || len(f.events) > 0 {
		t.Fatalf("an unlicensed install paused %v", f.sig.paused)
	}
}

func TestWindowStopResumesAfterTheResetWithoutHelp(t *testing.T) {
	f := newWin(t)
	f.ws = []Window{f.fiveHour(92)}
	f.g.Check(context.Background())

	// Just before the reset, and inside the grace after it: nothing yet.
	f.clock.t = t0.Add(2 * time.Hour)
	if got := f.g.ResumeDue(context.Background()); len(got) > 0 {
		t.Fatalf("resumed %v at the reset itself, before the grace", got)
	}
	f.clock.t = t0.Add(2*time.Hour + ResumeGrace)
	got := f.g.ResumeDue(context.Background())
	if !reflect.DeepEqual(got, []string{"a", "b"}) {
		t.Fatalf("resumed %v after the reset, want a and b", got)
	}
	if last := f.events[len(f.events)-1]; last.Kind != "resumed" {
		t.Errorf("last notice %+v, want a resume", last)
	}
	if len(f.g.State().Paused) != 0 {
		t.Error("still tracking sessions it has resumed")
	}
	// Once only.
	if again := f.g.ResumeDue(context.Background()); len(again) > 0 {
		t.Errorf("resumed %v twice", again)
	}
}

func TestWindowStopWaitsForTheWindowThatResetsLast(t *testing.T) {
	f := newWin(t)
	week := Window{Name: WindowSevenDay, UsedPct: 93, ResetsAt: t0.Add(3 * 24 * time.Hour), ObservedAt: t0}
	f.ws = []Window{f.fiveHour(95), week}
	f.g.Check(context.Background())
	if f.events[0].Window != WindowSevenDay {
		t.Fatalf("notice names %q, want the weekly window, which resets last", f.events[0].Window)
	}
	f.clock.t = t0.Add(5 * time.Hour)
	if got := f.g.ResumeDue(context.Background()); len(got) > 0 {
		t.Fatalf("resumed %v at the five-hour reset with the week still over the share", got)
	}
}

func TestWindowStopFiresOncePerWindowAndRespectsAManualResume(t *testing.T) {
	f := newWin(t)
	f.ws = []Window{f.fiveHour(91)}
	f.g.Check(context.Background())

	// The user resumes "a" by hand. The daemon tells the guard, which forgets it.
	f.g.Release(context.Background(), "a")
	f.sig.paused = nil
	f.clock.t = t0.Add(10 * time.Minute)
	w := f.fiveHour(94)
	w.ResetsAt = t0.Add(2*time.Hour + 3*time.Second) // the same window, reported a few seconds apart
	f.ws = []Window{w}
	if f.g.Check(context.Background()) || len(f.sig.paused) > 0 {
		t.Fatalf("paused %v again in the same window after the user resumed by hand", f.sig.paused)
	}
	f.clock.t = t0.Add(2*time.Hour + ResumeGrace)
	if got := f.g.ResumeDue(context.Background()); !reflect.DeepEqual(got, []string{"b"}) {
		t.Fatalf("resumed %v, want only b: a was taken over by the user", got)
	}

	// The next window crossing is a new window, and fires again.
	f.clock.t = t0.Add(4 * time.Hour)
	f.ws = []Window{f.fiveHour(95)}
	if !f.g.Check(context.Background()) {
		t.Fatal("did not fire in the next window")
	}
}

func TestWindowStopWithNothingRunningDoesNotLatch(t *testing.T) {
	f := newWin(t)
	f.sig.kinds = map[string]string{}
	f.ws = []Window{f.fiveHour(95)}
	if f.g.Check(context.Background()) || len(f.events) > 0 {
		t.Fatal("announced a stop that paused nothing")
	}
	// A session Caprock starts later in the window is still covered.
	f.sig.kinds["late"] = "claude"
	if !f.g.Check(context.Background()) || !reflect.DeepEqual(f.sig.paused, []string{"late"}) {
		t.Fatalf("paused %v, want the session started after the crossing", f.sig.paused)
	}
}

func TestWindowStopKeepsItsPromiseAfterTheSettingIsTurnedOff(t *testing.T) {
	f := newWin(t)
	f.ws = []Window{f.fiveHour(95)}
	f.g.Check(context.Background())
	f.set = WindowSettings{} // off, and the licence gone
	f.clock.t = t0.Add(3 * time.Hour)
	if got := f.g.ResumeDue(context.Background()); len(got) != 2 {
		t.Fatalf("resumed %v; a pause the guard made must be undone by it", got)
	}
}

func TestWindowStopDropsASessionThatEndedWhilePaused(t *testing.T) {
	f := newWin(t)
	f.ws = []Window{f.fiveHour(95)}
	f.g.Check(context.Background())
	f.sig.ended["b"] = true
	f.clock.t = t0.Add(3 * time.Hour)
	if got := f.g.ResumeDue(context.Background()); !reflect.DeepEqual(got, []string{"a"}) {
		t.Fatalf("resumed %v, want a only", got)
	}
	if len(f.g.State().Paused) != 0 {
		t.Error("kept a session that no longer exists")
	}
}

func TestWindowStopStateSurvivesARestart(t *testing.T) {
	f := newWin(t)
	f.ws = []Window{f.fiveHour(95)}
	f.g.Check(context.Background())
	saved := f.saved[len(f.saved)-1]

	// A new daemon: a fresh guard loaded from what the old one saved.
	g := newWin(t)
	g.g.Load(saved)
	g.clock.t = t0.Add(10 * time.Minute)
	g.ws = []Window{g.fiveHour(96)}
	g.ws[0].ResetsAt = t0.Add(2 * time.Hour)
	if g.g.Check(context.Background()) {
		t.Error("the latch was lost across the restart")
	}
	g.clock.t = t0.Add(3 * time.Hour)
	if got := g.g.ResumeDue(context.Background()); len(got) != 2 {
		t.Fatalf("resumed %v after a restart, want both", got)
	}
}

func TestWindowStopLoweredShareFiresAgain(t *testing.T) {
	f := newWin(t)
	f.ws = []Window{f.fiveHour(95)}
	f.g.Check(context.Background())
	f.g.Release(context.Background(), "a")
	f.g.Release(context.Background(), "b")
	f.g.ResetLatch(context.Background())
	f.sig.paused = nil
	if !f.g.Check(context.Background()) {
		t.Fatal("a changed share did not let the stop fire again")
	}
}

func TestWindowStopFailsOpenWhenFiguresCannotBeRead(t *testing.T) {
	f := newWin(t)
	f.g.Windows = func(context.Context) ([]Window, error) { return nil, errors.New("database is locked") }
	if f.g.Check(context.Background()) || len(f.sig.paused) > 0 {
		t.Fatal("paused without being able to read the windows")
	}
}
