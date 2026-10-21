package alerts

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/narrate"
)

// A turn that ended on a question is "Needs your answer", in the app and in
// Telegram; one that asked nothing stays "Finished" (owner, 2026-10-21).
func TestATurnEndingOnAQuestionNeedsAnAnswer(t *testing.T) {
	asks := finished(`{"last_assistant_message":"Tests pass.\nShould I also add a search tool now, or leave it for a separate PR?"}`)
	done := finished(`{"last_assistant_message":"All tests pass and the branch is pushed."}`)
	failed := Alert{Kind: KindFinished, SessionID: "s", Trigger: event.Event{Kind: event.KindThrottle, Payload: json.RawMessage(`{"error":"rate_limit"}`)}}
	if asks.Need() != narrate.NeedAsks || done.Need() != narrate.NeedDone || failed.Need() != narrate.NeedError {
		t.Fatalf("needs: %q %q %q", asks.Need(), done.Need(), failed.Need())
	}
	if (Alert{Kind: KindApproval}).Need() != "" {
		t.Fatal("an approval has no turn need")
	}
	d := Details{Cwd: "/w/proj"}
	d.Reply = "Should I also add a search tool now, or leave it for a separate PR?"
	n := Notify(asks, d, "")
	if n.Kind != "question" || !strings.HasPrefix(n.Title, "Needs your answer · ") {
		t.Fatalf("asks notification: %+v", n)
	}
	if n := Notify(done, Details{Cwd: "/w/proj"}, ""); n.Kind != "finished" || !strings.HasPrefix(n.Title, "Finished · ") {
		t.Fatalf("done notification: %+v", n)
	}
	if n := Notify(failed, Details{Cwd: "/w/proj"}, ""); n.Kind != "error" || !strings.HasPrefix(n.Title, "Stopped: rate limit") {
		t.Fatalf("failed notification: %+v", n)
	}
	if m := Message(asks, d); !strings.Contains(m, "Needs your answer") {
		t.Fatalf("telegram: %q", m)
	}
	if m := Message(done, Details{Cwd: "/w/proj"}); !strings.Contains(m, "Finished") {
		t.Fatalf("telegram done: %q", m)
	}
}

// The rules ask each sender with the turn's need, so a Done turn wanted by
// Telegram but not by the app is decided once and sent where it is wanted —
// and one wanted by nobody spends no cooldown and no slot of the hour.
func TestTheRulesAskWithTheTurnsNeed(t *testing.T) {
	var asked []string
	r := New(nil)
	r.EnabledFor = func(k Kind, need string) bool {
		asked = append(asked, string(k)+"/"+need)
		return need != narrate.NeedDone
	}
	stop := func(id, msg string, at time.Time) event.Event {
		b, _ := json.Marshal(map[string]string{"last_assistant_message": msg})
		return event.Event{SessionID: id, Kind: event.KindAgentStop, Ts: at, Payload: b}
	}
	r.Observe(stop("done", "Pushed.", t0), t0)
	r.Observe(stop("asks", "Merge it?", t0), t0)
	got := r.Due(t0.Add(FinishedAfter))
	if len(got) != 1 || got[0].SessionID != "asks" {
		t.Fatalf("due: %+v (asked %v)", got, asked)
	}
	if r.sessions["done"] != nil && len(r.sessions["done"].lastSent) != 0 {
		t.Fatal("a turn nobody wanted spent a cooldown")
	}
}
