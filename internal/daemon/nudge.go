package daemon

import (
	"time"

	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/narrate"
)

// readAfterInput is when an agent read from a transcript or telemetry file is
// read again after a message was submitted to it, instead of at its poll
// tick (Codex every 5 s, Gemini every 3): its next line is the prompt, and
// the poll alone left the status a tick behind what the user just did.
var readAfterInput = []time.Duration{300 * time.Millisecond, 1200 * time.Millisecond, 3 * time.Second}

// nudged is the agents manager's OnNudge: input typed into an owned session
// that its status reads before the session writes an event (narrate.Nudge).
// It runs on the keystroke's goroutine, so it only publishes and schedules.
func (d *Daemon) nudged(id, kind string, n narrate.Nudge) {
	d.publishStatus(id, n)
	if n.Kind != narrate.NudgeSubmit {
		return
	}
	// A provisional status ends by itself; screens are told to ask again
	// then, or they would keep "working" for a message nobody answered.
	time.AfterFunc(narrate.NudgeWindow+150*time.Millisecond, func() { d.publishStatus(id, n) })
	switch kind {
	case agents.AgentCodex:
		for _, in := range d.codexIngesters() {
			for _, after := range readAfterInput {
				time.AfterFunc(after, in.Kick)
			}
		}
	case agents.AgentGemini:
		for _, after := range readAfterInput {
			time.AfterFunc(after, d.gemIn.Kick)
		}
	}
}

// Nudge is the newest input typed into an owned session (narrate.Nudge).
func (a *agentAdapter) Nudge(id string) (narrate.Nudge, bool) { return a.m.Nudge(id) }

func (d *Daemon) publishStatus(id string, n narrate.Nudge) {
	d.bus.Publish(bus.Frame{Type: bus.FrameStatus, Data: map[string]any{
		"session_id": id, "kind": n.Kind, "at": n.At.UnixMilli(),
	}})
}
