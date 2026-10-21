package narrate

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
)

func TestAsksSomethingReadsTheEndOfTheMessage(t *testing.T) {
	cases := []struct {
		name, msg string
		asks      bool
		detail    string
	}{
		{"a closing question", "Tests pass and the branch is pushed.\n\nMerge it?", true, "question"},
		{"an either/or", "Should I also add a search tool now, or leave it for a separate PR?", true, "choice"},
		{"bold question", "Two options above.\n\n**Which one do we take?**", true, "choice"},
		{"question above a sign-off", "Want the release today?\nThanks!", true, "question"},
		{"question inside the last line", "You only connected one mailbox. Did you try Gmail yet? It needs an app password.", true, "question"},
		{"let me know", "The draft is in docs/plan.md. Let me know if the order works.", true, "question"},
		{"should I", "The preview is up. Should I merge once CI is green.", true, "question"},
		{"options with a cue", "Two ways to do it. Options:\n1. Fold Done under Continue\n2. A list of its own", true, "choice"},
		{"lettered options", "Pick one\na) keep the badge\nb) drop the badge", true, "choice"},
		{"a report", "All tests pass and the branch is pushed. Nothing else is needed from you.", false, ""},
		{"a numbered summary", "Done:\n1. Fixed the sidebar\n2. Added tests\n3. Updated the docs", false, ""},
		{"a question in code only", "Fixed the regexp:\n```\nre := `a?b`\nok?\n```\nAll green.", false, ""},
		{"a question long before the end", "Was it the cache?\nIt was.\nFixed it.\nAdded a test.\nPushed.", false, ""},
		{"empty", "", false, ""},
		{"rhetorical but answered", "Why did it fail? The index was missing. Added it.", true, "question"},
		{"non-English report", "Τα τεστ περνούν. Τέλος.", false, ""},
		{"non-English question", "Να το συγχωνεύσω;\nΈτοιμο?", true, "question"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			ok, detail, _ := AsksSomething(c.msg)
			if ok != c.asks || (c.asks && detail != c.detail) {
				t.Fatalf("AsksSomething(%q) = %v %q; want %v %q", c.msg, ok, detail, c.asks, c.detail)
			}
		})
	}
}

func stopWith(ts time.Time, msg string) event.Event {
	b, _ := json.Marshal(map[string]string{"last_assistant_message": msg})
	return event.Event{Kind: event.KindAgentStop, Ts: ts, Payload: b}
}

func TestStopSplitsIntoNeedsYouAndDone(t *testing.T) {
	base := time.Date(2026, 10, 21, 12, 0, 0, 0, time.UTC)
	opt := Options{Now: base.Add(time.Minute)}

	asks := Summarize([]event.Event{stopWith(base, "Merge it?")}, opt)
	if asks.Health != HealthWaiting || asks.Need == nil || asks.Need.Reason != NeedAsks || !asks.Need.Guess || asks.Need.Text != "Merge it?" {
		t.Fatalf("asks: %+v need=%+v", asks, asks.Need)
	}
	done := Summarize([]event.Event{stopWith(base, "All green.\nPushed the branch.")}, opt)
	if done.Health != HealthDone || done.Phrase != "done" || done.Need == nil || done.Need.Reason != NeedDone || !done.Need.Guess || done.Need.Text != "Pushed the branch." {
		t.Fatalf("done: %+v need=%+v", done, done.Need)
	}
	// A Stop with no message (an older Claude Code) is Done too.
	if a := Summarize([]event.Event{{Kind: event.KindAgentStop, Ts: base}}, opt); a.Health != HealthDone {
		t.Fatalf("no message: %+v", a)
	}
	// Working sessions carry no Need.
	if a := Summarize([]event.Event{{Kind: event.KindTurnUser, Ts: base}}, opt); a.Need != nil {
		t.Fatalf("working has a need: %+v", a.Need)
	}
}

func TestCertainReasons(t *testing.T) {
	base := time.Date(2026, 10, 21, 12, 0, 0, 0, time.UTC)
	opt := Options{Now: base.Add(time.Minute)}
	cases := []struct {
		name   string
		events []event.Event
		reason string
		detail string
		phrase string
	}{
		{"permission", []event.Event{{Kind: event.KindPermissionPrompt, Tool: "Bash", Ts: base, Payload: json.RawMessage(`{"tool_input":{"command":"make"}}`)}}, NeedPermission, "", "waiting for approval — running `make`"},
		{"question", []event.Event{{Kind: event.KindPermissionPrompt, Tool: "AskUserQuestion", Ts: base}}, NeedQuestion, "", "waiting for your answer"},
		{"plan", []event.Event{{Kind: event.KindPermissionPrompt, Tool: "ExitPlanMode", Ts: base}}, NeedPlan, "", "plan to approve"},
		{"stop failure", []event.Event{{Kind: event.KindThrottle, Ts: base, Payload: json.RawMessage(`{"error":"server_error"}`)}}, NeedError, "server error", "stopped: server error"},
		{"stop failure without a reason", []event.Event{{Kind: event.KindThrottle, Ts: base}}, NeedError, "", "stopped on an error"},
		{"a Stop after a StopFailure", []event.Event{
			{Kind: event.KindTurnUser, Ts: base.Add(-time.Minute)},
			{Kind: event.KindThrottle, Ts: base, Payload: json.RawMessage(`{"error":"rate_limit"}`)},
			stopWith(base.Add(time.Second), "All done."),
		}, NeedError, "rate limit", "stopped: rate limit"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			a := Summarize(c.events, opt)
			if a.Health != HealthWaiting || a.Need == nil || a.Need.Reason != c.reason || a.Need.Detail != c.detail || a.Need.Guess || a.Phrase != c.phrase {
				t.Fatalf("got %s %q need=%+v; want %s %q %q", a.Health, a.Phrase, a.Need, c.reason, c.detail, c.phrase)
			}
		})
	}
	// A StopFailure in an earlier turn does not colour this one.
	a := Summarize([]event.Event{
		{Kind: event.KindThrottle, Ts: base, Payload: json.RawMessage(`{"error":"rate_limit"}`)},
		{Kind: event.KindTurnUser, Ts: base.Add(time.Second)},
		stopWith(base.Add(2*time.Second), "Pushed."),
	}, opt)
	if a.Health != HealthDone {
		t.Fatalf("earlier failure leaked: %+v", a)
	}
	// A subagent's StopFailure is not the session stopping.
	if a := Summarize([]event.Event{{Kind: event.KindThrottle, AgentID: "a1", Ts: base}}, opt); a.Health != HealthWorking || a.Need != nil {
		t.Fatalf("subagent failure: %+v", a)
	}
}

func TestAMoveHoldsUntilTheNextTurn(t *testing.T) {
	base := time.Date(2026, 10, 21, 12, 0, 0, 0, time.UTC)
	opt := func(m *Move) Options { return Options{Now: base.Add(time.Hour), Move: m} }
	done := stopWith(base, "Pushed.")
	asks := stopWith(base, "Merge it?")

	a := Summarize([]event.Event{done}, opt(&Move{StopAt: base, Needs: true}))
	if a.Health != HealthWaiting || a.Need == nil || !a.Need.Moved || a.Need.Guess || a.Need.Reason != NeedAsks {
		t.Fatalf("needs me: %+v need=%+v", a, a.Need)
	}
	a = Summarize([]event.Event{asks}, opt(&Move{StopAt: base, Needs: false}))
	if a.Health != HealthDone || a.Need == nil || !a.Need.Moved {
		t.Fatalf("not needed: %+v need=%+v", a, a.Need)
	}
	// The next turn's Stop is a new reading.
	next := stopWith(base.Add(time.Minute), "Pushed again.")
	if a := Summarize([]event.Event{done, {Kind: event.KindTurnUser, Ts: base.Add(time.Second)}, next}, opt(&Move{StopAt: base, Needs: true})); a.Health != HealthDone || a.Need.Moved {
		t.Fatalf("move outlived its turn: %+v", a)
	}
	// A certain reason is never moved.
	fail := event.Event{Kind: event.KindThrottle, Ts: base, Payload: json.RawMessage(`{"error":"rate_limit"}`)}
	if a := Summarize([]event.Event{fail}, opt(&Move{StopAt: base, Needs: false})); a.Health != HealthWaiting || a.Need.Reason != NeedError {
		t.Fatalf("certain reason moved: %+v", a)
	}
}

func TestBackgroundAndRejectionNeeds(t *testing.T) {
	base := time.Date(2026, 10, 21, 12, 0, 0, 0, time.UTC)
	// Subagents still working after a Done turn: working, no Need.
	a := Summarize([]event.Event{stopWith(base, "Pushed.")}, Options{Now: base.Add(time.Second), LiveSubagents: 1})
	if a.Health != HealthWorking || a.Need != nil {
		t.Fatalf("background: %+v", a)
	}
	// A rejected dialog returns to the prompt, which asks what to do instead.
	prompt := event.Event{Kind: event.KindPermissionPrompt, Tool: "Bash", Ts: base}
	a = Summarize([]event.Event{prompt}, Options{Now: base.Add(2 * time.Second), Nudge: &Nudge{At: base.Add(time.Second), Kind: NudgeRejected}})
	if a.Health != HealthWaiting || a.Need == nil || a.Need.Reason != NeedAsks || a.Need.Guess {
		t.Fatalf("rejected: %+v need=%+v", a, a.Need)
	}
	// Enter at a Done session reads working for the nudge window.
	a = Summarize([]event.Event{stopWith(base, "Pushed.")}, Options{Now: base.Add(2 * time.Second), Nudge: &Nudge{At: base.Add(time.Second), Kind: NudgeSubmit}})
	if a.Health != HealthWorking || !a.Provisional || a.Need != nil {
		t.Fatalf("submit at done: %+v", a)
	}
}
