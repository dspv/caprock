package cursor

import (
	"context"
	"encoding/json"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/rollup"
)

// A turn's end, its timings, compactions and the permission mode — what an
// editor chat records that Claude Code's hooks would have said
// (.ai/25-cursor.md § How it maps).

// turnSpan is one turn as a pass reads it: its prompt and what its rows
// add up to.
type turnSpan struct {
	prompt string
	at     time.Time // the prompt's own time, zero when Cursor kept none
	model  string
	rows   int
	// last is the newest time a row of the turn was stored at.
	last time.Time
	// sent and ended bound the turn's requests (timingInfo), unix ms.
	sent, ended int64
	// requestMs adds up each request's time from sending to its reply's
	// end; thinkingMs the model's thinking (thinkingDurationMs).
	requestMs, thinkingMs int64
}

func (t *turnSpan) add(b Bubble, ts time.Time) {
	t.rows++
	if ts.After(t.last) {
		t.last = ts
	}
	if b.SentAt > 0 {
		if t.sent == 0 || b.SentAt < t.sent {
			t.sent = b.SentAt
		}
		t.ended = max(t.ended, b.EndedAt)
		t.requestMs += b.EndedAt - b.SentAt
	}
	t.thinkingMs += b.ThinkingMs
}

// stop is the turn's agent.stop, as Claude Code's Stop hook marks one: when
// the next prompt arrives (next, its time), or when Cursor says the chat
// stopped (finished). It carries the turn's timings where Cursor recorded
// them — duration_ms from its first request sent to its last reply's end,
// request_ms the requests' own time, thinking_ms the model's thinking — and
// is placed at the turn's last row, before the next prompt.
func (t *turnSpan) stop(c Composer, next time.Time, finished bool) (postEvent, bool) {
	at := t.last
	if !next.IsZero() && !at.Before(next) {
		at = next.Add(-time.Millisecond)
	}
	if at.IsZero() {
		return postEvent{}, false
	}
	fields := map[string]any{"model": t.model, "stop_reason": "next_prompt"}
	if finished {
		fields["stop_reason"] = "finished"
		fields["status"] = c.Status
	}
	if t.sent > 0 && t.ended > t.sent {
		fields["duration_ms"] = t.ended - t.sent
		fields["request_ms"] = t.requestMs
	}
	if t.thinkingMs > 0 {
		fields["thinking_ms"] = t.thinkingMs
	}
	return postEvent{
		Event: event.Event{
			Ts: at, SessionID: c.ID, Source: event.SourceCursor, Kind: event.KindAgentStop,
			Model: t.model, Key: "cu-stop:" + c.ID + ":" + t.prompt,
		},
		fields: fields,
	}, true
}

// compaction records the summary Cursor wrote at bubbles[i] in place of the
// conversation before it as context.compacted, Claude Code's finished
// compaction: trigger "auto" (Cursor summarizes on its own), pre_tokens the
// reading of the prompt before it and post_tokens the reading of the prompt
// after (contextWindowStatusAtCreation), each left out when that prompt has
// none. The reading before is taken as its turn started, so it is a floor of
// what the context held when Cursor summarized. A summary in the newest turn
// waits for the next prompt, which measures what it kept, unless the chat
// has stopped.
func (in *Ingester) compaction(ctx context.Context, c Composer, bubbles []Bubble, i int, at time.Time, cwd string,
	info rollup.SessionInfo, common func(map[string]any) map[string]any) error {
	b := bubbles[i]
	var pre, window, post int64
	for j := i - 1; j >= 0; j-- {
		if bubbles[j].User {
			pre, window = bubbles[j].ContextUsed, bubbles[j].ContextLimit
			break
		}
	}
	found := false
	for j := i + 1; j < len(bubbles); j++ {
		if bubbles[j].User {
			post, found = bubbles[j].ContextUsed, true
			if window == 0 {
				window = bubbles[j].ContextLimit
			}
			break
		}
	}
	if !found && !c.Finished() {
		return nil
	}
	fields := common(map[string]any{"trigger": "auto", "cwd": cwd, "summary_chars": b.Summary.Chars,
		"measured_by": "prompt_readings"})
	if pre > 0 {
		fields["pre_tokens"] = pre
	}
	if post > 0 {
		fields["post_tokens"] = post
	}
	if window > 0 {
		fields["context_window"] = window
	}
	payload, _ := json.Marshal(fields)
	_, err := in.record(ctx, &event.Event{
		Ts: at, SessionID: c.ID, Source: event.SourceCursor, Kind: event.KindContextCompacted,
		Payload: payload, Key: "cu-compact:" + b.ID,
	}, info)
	return err
}

// Cursor's modes in the permission-mode vocabulary (api.PermissionModeView):
// Plan is Claude Code's plan; Ask answers and changes nothing, a mode Claude
// Code has no word for; Agent asks before a terminal command unless Cursor's
// auto-run is on, which only each command records.
const (
	ModeAsk     = "ask"
	ModeAutoRun = "autoRun"
)

// chatMode is the mode a chat's unifiedMode says on its own: plan or ask; ""
// for agent, whose mode its commands tell (callMode).
func chatMode(unified string) string {
	switch unified {
	case "plan":
		return "plan"
	case "chat":
		return ModeAsk
	}
	return ""
}

// callMode is what a terminal command says of the mode: Cursor ran it
// without asking (reviewData.approvalType "full_auto", its auto-run), or the
// person was asked (a userDecision); "" when it records neither.
func callMode(t *Tool) string {
	if ToolName(t.Name) != "Bash" {
		return ""
	}
	switch {
	case t.Approval == "full_auto":
		return ModeAutoRun
	case t.Decision != "":
		return "default"
	}
	return ""
}

// HookMode is the mode sessionStart's composer_mode names.
func HookMode(composer string) string {
	switch composer {
	case "plan":
		return "plan"
	case "ask", "chat":
		return ModeAsk
	case "agent", "edit":
		return "default"
	}
	return ""
}
