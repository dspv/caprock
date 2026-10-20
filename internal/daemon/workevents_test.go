package daemon

import (
	"context"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/api"
	"github.com/dspv/caprock/internal/event"
)

// A session whose events have not moved is not read again: the board keeps
// its newest events by generation, works its state out of them afresh, and
// reads again as soon as an event lands (F17).
func TestWorkBoardKeepsUnchangedSessionsEvents(t *testing.T) {
	w, _, d, now := newTestWork(t)
	ctx := context.Background()
	workSession(t, d, "hand", "claude", "/r", "feat", false, now.Add(-time.Minute))
	boundAt(t, d, "hand", event.KindTurnUser, now.Add(-3*time.Minute), "")
	boundAt(t, d, "hand", event.KindAgentStop, now.Add(-2*time.Minute), "")
	state := func() string {
		t.Helper()
		out, err := w.Work(ctx)
		if err != nil {
			t.Fatal(err)
		}
		for _, s := range out.Sessions {
			if s.SessionID == "hand" {
				return s.State
			}
		}
		t.Fatal("session missing from the board")
		return ""
	}
	if got := state(); got != api.WorkAtPrompt {
		t.Fatalf("state = %q, want at the prompt", got)
	}
	kept := w.events.m["hand"]
	if kept == nil || kept.turns == nil {
		t.Fatal("the session's turn events were not kept")
	}
	if got := state(); got != api.WorkAtPrompt || w.events.m["hand"] != kept {
		t.Fatalf("unchanged session: state %q, entry replaced %v", got, w.events.m["hand"] != kept)
	}
	boundAt(t, d, "hand", event.KindTurnUser, now.Add(-10*time.Second), "")
	if got := state(); got != api.WorkWorking {
		t.Fatalf("state after a new turn = %q, want working", got)
	}
	if w.events.m["hand"] == kept {
		t.Fatal("a new event did not replace the kept entry")
	}
}

// Today's spend of a session is summed again only when its events move, and
// then it is the new sum.
func TestWorkBoardTodaySpendFollowsTheSession(t *testing.T) {
	w, _, d, now := newTestWork(t)
	ctx := context.Background()
	workSession(t, d, "spend", "claude", "/r", "feat", false, now.Add(-time.Minute))
	priced := func(usd float64, at time.Time) {
		t.Helper()
		workEvent(t, d, event.Event{SessionID: "spend", Source: event.SourceTranscript, Kind: event.KindTurnAssistant, Ts: at, CostUSD: &usd})
	}
	spent := func() float64 {
		t.Helper()
		out, err := w.Work(ctx)
		if err != nil {
			t.Fatal(err)
		}
		for _, s := range out.Sessions {
			if s.SessionID == "spend" {
				return s.TodayUSD
			}
		}
		t.Fatal("session missing from the board")
		return 0
	}
	priced(1.25, now.Add(-time.Hour))
	priced(9, now.Add(-30*time.Hour)) // yesterday
	if got := spent(); got != 1.25 {
		t.Fatalf("today = %v, want 1.25", got)
	}
	if got := spent(); got != 1.25 || !w.events.m["spend"].todayRead {
		t.Fatalf("unchanged session: today = %v", got)
	}
	priced(0.5, now.Add(-time.Minute))
	if got := spent(); got != 1.75 {
		t.Fatalf("today after a new turn = %v, want 1.75", got)
	}
}
