package alerts

import (
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
)

var t0 = time.Date(2026, 10, 4, 12, 0, 0, 0, time.UTC)

func ev(id string, k event.Kind, at time.Time) event.Event {
	return event.Event{SessionID: id, Kind: k, Ts: at}
}

func allOn(Kind) bool { return true }

func TestAPermissionDialogAlertsAtOnceAndOncePerWait(t *testing.T) {
	r := New(allOn)
	got := r.Observe(ev("s", event.KindPermissionPrompt, t0), t0)
	if len(got) != 1 || got[0].Kind != KindApproval || got[0].SessionID != "s" {
		t.Fatalf("first dialog: %+v", got)
	}
	// Claude Code may repeat the notification for the same dialog.
	if got := r.Observe(ev("s", event.KindPermissionPrompt, t0.Add(5*time.Second)), t0.Add(5*time.Second)); len(got) != 0 {
		t.Fatalf("same wait alerted twice: %+v", got)
	}
}

func TestRapidDialogsInOneSessionAreOneInterruption(t *testing.T) {
	r := New(allOn)
	at := t0
	n := 0
	for i := 0; i < 5; i++ {
		n += len(r.Observe(ev("s", event.KindPermissionPrompt, at), at))
		at = at.Add(10 * time.Second)
		r.Observe(ev("s", event.KindToolPost, at), at) // answered
		at = at.Add(10 * time.Second)
	}
	if n != 1 {
		t.Fatalf("%d alerts for five dialogs inside the cooldown; want 1", n)
	}
	// After the cooldown a new dialog is news again.
	at = at.Add(Cooldown)
	if got := r.Observe(ev("s", event.KindPermissionPrompt, at), at); len(got) != 1 {
		t.Fatalf("dialog after the cooldown: %+v", got)
	}
}

func TestFinishedWaitsAMinuteAndAnyActivityCancelsIt(t *testing.T) {
	r := New(allOn)
	r.Observe(ev("s", event.KindAgentStop, t0), t0)
	if got := r.Due(t0.Add(FinishedAfter - time.Second)); len(got) != 0 {
		t.Fatalf("finished before the minute: %+v", got)
	}
	got := r.Due(t0.Add(FinishedAfter))
	if len(got) != 1 || got[0].Kind != KindFinished {
		t.Fatalf("finished after the minute: %+v", got)
	}
	if got := r.Due(t0.Add(2 * FinishedAfter)); len(got) != 0 {
		t.Fatalf("finished twice: %+v", got)
	}

	// The owner answers within the minute: nobody is paged.
	r2 := New(allOn)
	r2.Observe(ev("s", event.KindAgentStop, t0), t0)
	r2.Observe(ev("s", event.KindTurnUser, t0.Add(20*time.Second)), t0.Add(20*time.Second))
	if got := r2.Due(t0.Add(5 * FinishedAfter)); len(got) != 0 {
		t.Fatalf("a prompt inside the minute still paged: %+v", got)
	}
}

// The transcript catches up after the hook: its events carry the time they
// happened, before the Stop, and must not read as somebody answering.
func TestALateTranscriptEventDoesNotCancel(t *testing.T) {
	r := New(allOn)
	r.Observe(ev("s", event.KindAgentStop, t0), t0)
	r.Observe(ev("s", event.KindTurnAssistant, t0.Add(-2*time.Second)), t0.Add(3*time.Second))
	if got := r.Due(t0.Add(FinishedAfter)); len(got) != 1 {
		t.Fatalf("late transcript turn cancelled finished: %+v", got)
	}
}

// A restart re-reads transcripts from the start; their old Stops must not
// page anyone.
func TestOldEventsPageNobody(t *testing.T) {
	r := New(allOn)
	old := t0.Add(-time.Hour)
	r.Observe(ev("a", event.KindAgentStop, old), t0)
	if got := r.Observe(ev("b", event.KindPermissionPrompt, old), t0); len(got) != 0 {
		t.Fatalf("old dialog paged: %+v", got)
	}
	if got := r.Due(t0.Add(FinishedAfter)); len(got) != 0 {
		t.Fatalf("old stop paged: %+v", got)
	}
}

func TestASubagentStopIsNotTheSessionFinishing(t *testing.T) {
	r := New(allOn)
	e := ev("s", event.KindAgentStop, t0)
	e.AgentID = "sub-1"
	r.Observe(e, t0)
	if got := r.Due(t0.Add(FinishedAfter)); len(got) != 0 {
		t.Fatalf("subagent stop paged: %+v", got)
	}
}

func TestASwitchedOffKindSendsNothingAndCostsNothing(t *testing.T) {
	r := New(func(k Kind) bool { return k == KindFinished })
	if got := r.Observe(ev("s", event.KindPermissionPrompt, t0), t0); len(got) != 0 {
		t.Fatalf("approval sent while off: %+v", got)
	}
	if len(r.sent) != 0 {
		t.Fatal("a suppressed alert counted against the hourly cap")
	}
}

func TestTheHourlyCapHoldsAndSaysSo(t *testing.T) {
	r := New(allOn)
	var got []Alert
	for i := 0; i < HourlyCap+5; i++ {
		at := t0.Add(time.Duration(i) * time.Second)
		got = append(got, r.Observe(ev(string(rune('a'+i)), event.KindPermissionPrompt, at), at)...)
	}
	if len(got) != HourlyCap {
		t.Fatalf("%d alerts in an hour; want the cap, %d", len(got), HourlyCap)
	}
	for i, a := range got {
		if a.LastThisHour != (i == HourlyCap-1) {
			t.Fatalf("alert %d LastThisHour=%v", i, a.LastThisHour)
		}
	}
	later := t0.Add(time.Hour + time.Minute)
	if got := r.Observe(ev("zz", event.KindPermissionPrompt, later), later); len(got) != 1 {
		t.Fatalf("cap did not lift after the hour: %+v", got)
	}
}

func TestQuietSessionsAreForgotten(t *testing.T) {
	r := New(allOn)
	r.Observe(ev("s", event.KindAgentStop, t0), t0)
	r.Due(t0.Add(FinishedAfter))
	r.Due(t0.Add(FinishedAfter + Cooldown))
	if len(r.sessions) != 0 {
		t.Fatalf("%d sessions still held", len(r.sessions))
	}
}

// What leaves the machine is held to project, status, agent and link.
func TestTheMessageCarriesNothingElse(t *testing.T) {
	got := Message(Alert{Kind: KindApproval, SessionID: "s"}, "caprock", "Claude Code", "http://100.64.0.2:4173/#/session/s")
	want := "Caprock · caprock is waiting for approval\nClaude Code\nhttp://100.64.0.2:4173/#/session/s"
	if got != want {
		t.Fatalf("got %q\nwant %q", got, want)
	}
	if got := Message(Alert{Kind: KindApproval, Question: true}, "caprock", "Claude Code", ""); got != "Caprock · caprock is waiting for your answer\nClaude Code" {
		t.Fatalf("question: %q", got)
	}
	got = Message(Alert{Kind: KindFinished, LastThisHour: true}, "", "Codex", "")
	if !strings.HasPrefix(got, "Caprock · a session has finished\nCodex\n\nThat is 20 alerts") {
		t.Fatalf("got %q", got)
	}
	if strings.Contains(CheckMessage(""), "http") {
		t.Fatal("test message invented a link")
	}
}
