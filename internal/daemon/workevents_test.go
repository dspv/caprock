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
