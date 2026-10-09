package alerts

import (
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
)

func subEv(agent string, k event.Kind, at time.Time) event.Event {
	e := ev("s", k, at)
	e.AgentID = agent
	return e
}

// A turn that ends with a background subagent still working has not
// finished: Claude Code resumes the parent when the subagent is done. The
// owner was told "finished" while work he had asked for was still running.
func TestFinishedWaitsForBackgroundSubagents(t *testing.T) {
	r := New(allOn)
	r.Observe(subEv("a1", event.KindToolPre, t0.Add(-time.Second)), t0.Add(-time.Second))
	r.Observe(ev("s", event.KindAgentStop, t0), t0)
	at := t0.Add(5 * time.Minute)
	r.Observe(subEv("a1", event.KindToolPost, at.Add(-time.Minute)), at)
	if got := r.Due(at); len(got) != 0 {
		t.Fatalf("finished while a subagent works: %+v", got)
	}
	// A second one is still at work when the first stops.
	r.Observe(subEv("b2", event.KindToolPre, at), at)
	r.Observe(subEv("a1", event.KindAgentStop, at.Add(time.Second)), at.Add(time.Second))
	if got := r.Due(at.Add(2 * FinishedAfter)); len(got) != 0 {
		t.Fatalf("finished while the second subagent works: %+v", got)
	}
	// The last one stops; the parent is only now done, so the minute starts here.
	stop := at.Add(2*FinishedAfter + time.Second)
	r.Observe(subEv("b2", event.KindAgentStop, stop), stop)
	if got := r.Due(stop.Add(FinishedAfter - time.Second)); len(got) != 0 {
		t.Fatalf("finished before a minute after the last subagent: %+v", got)
	}
	if got := r.Due(stop.Add(FinishedAfter)); len(got) != 1 || got[0].Kind != KindFinished {
		t.Fatalf("finished a minute after the last subagent stopped: %+v", got)
	}
}

// A subagent never heard to stop is believed for the window only.
func TestASilentSubagentHoldsFinishedForTheWindowOnly(t *testing.T) {
	r := New(allOn)
	r.Observe(subEv("a1", event.KindToolPre, t0), t0)
	r.Observe(ev("s", event.KindAgentStop, t0.Add(time.Second)), t0.Add(time.Second))
	if got := r.Due(t0.Add(10 * time.Minute)); len(got) != 0 {
		t.Fatalf("finished while a subagent was recently heard: %+v", got)
	}
	if got := r.Due(t0.Add(subagentWindow + time.Second)); len(got) != 1 {
		t.Fatalf("a silent subagent held finished past the window: %+v", got)
	}
}

// A dialog is still a dialog with subagents running.
func TestApprovalAlertsWhileSubagentsWork(t *testing.T) {
	r := New(allOn)
	r.Observe(subEv("a1", event.KindToolPre, t0), t0)
	r.Observe(ev("s", event.KindAgentStop, t0.Add(time.Second)), t0.Add(time.Second))
	at := t0.Add(2 * time.Second)
	if got := r.Observe(subEv("a1", event.KindPermissionPrompt, at), at); len(got) != 1 || got[0].Kind != KindApproval {
		t.Fatalf("subagent's dialog: %+v", got)
	}
}
