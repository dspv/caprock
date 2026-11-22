package narrate

import (
	"encoding/json"
	"strings"

	"github.com/dspv/caprock/internal/event"
)

// TurnOpen reports whether a Claude Code session's main thread is in a turn
// and waits on the model: by its hooks, a prompt or a compaction Claude Code
// started with no Stop after it, and no call running — every main-thread
// tool.pre since has its tool.post (by tool_use_id). A call still running is
// work, not a turn gone quiet: a build or a test suite can run half an hour
// with nothing logged. Events are oldest first, as Summarize takes them; only
// the ones given are read, so a window that holds no turn event says false.
//
// It is what a session row reads to say *no reply 2d* when a turn has had no
// event for a long time (.ai/04-ui.md § Sidebar, *Stalled*); the chat's
// openTurn (ui/src/lib/chatActivity.ts), with no step running, is its twin
// over the session's events. The kinds it reads are the queue's turnKinds
// and its reading is turnWaiting's (internal/daemon/queue.go), with three
// differences: a running call is not open here, a permission prompt is the
// user's to answer, never a turn gone quiet, and a prompt Claude Code wrote
// for itself (a background task's notification) is passed over, as the chat
// passes over it.
func TurnOpen(events []event.Event) bool {
	done := map[string]bool{}
	inTurn := false
	for i := len(events) - 1; i >= 0; i-- {
		e := events[i]
		if e.Source != event.SourceHook || e.Subagent() {
			continue
		}
		switch e.Kind {
		case event.KindTurnUser:
			if harnessPrompt(e.Payload) {
				continue
			}
			return true
		case event.KindToolPost:
			if id := payloadKey(e.Payload, "tool_use_id"); id != "" {
				done[id] = true
			}
			inTurn = true
		case event.KindToolPre:
			id := payloadKey(e.Payload, "tool_use_id")
			if id == "" || !done[id] {
				return false // a call is running
			}
			inTurn = true
		case event.KindContextCompact:
			if payloadKey(e.Payload, "trigger") == "manual" {
				continue
			}
			inTurn = true
		case event.KindAgentSpawn:
			if payloadKey(e.Payload, "source") == "compact" {
				continue
			}
			return false
		case event.KindPermissionPrompt, event.KindAgentStop, event.KindContextClear,
			event.KindSessionContinue, event.KindThrottle, event.KindSessionEnd:
			return false
		}
	}
	// The window began inside the turn: its prompt is older than the events read.
	return inTurn
}

// harnessPrompt is a prompt Claude Code wrote itself: a background task's
// notification, a slash command's echo or output (lib/chat.ts noticeLine).
func harnessPrompt(raw json.RawMessage) bool {
	p := strings.TrimSpace(payloadKey(raw, "prompt"))
	for _, tag := range []string{"<task-notification", "<command-name", "<command-message", "<local-command-", "<bash-"} {
		if strings.HasPrefix(p, tag) {
			return true
		}
	}
	return false
}

func payloadKey(raw json.RawMessage, key string) string {
	var m map[string]any
	if json.Unmarshal(raw, &m) != nil {
		return ""
	}
	s, _ := m[key].(string)
	return s
}
