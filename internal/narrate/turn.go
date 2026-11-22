package narrate

import (
	"encoding/json"
	"strings"

	"github.com/dspv/caprock/internal/event"
)

// TurnOpen reports whether a Claude Code session's main thread is in a turn
// by its hooks: the newest main-thread hook event that opens or closes a turn
// is a prompt, a call, or a compaction Claude Code started, with no Stop
// after it. Events are oldest first, as Summarize takes them; only the ones
// given are read, so a window that holds no such event says false.
//
// It is what a session row reads to say *no reply 2d* when a turn has had no
// event for a long time (.ai/04-ui.md § Sidebar, *Stalled*); the chat's
// openTurn (ui/src/lib/chatActivity.ts) is its twin over the session's
// events. The kinds it reads are the queue's turnKinds and its reading is
// turnWaiting's (internal/daemon/queue.go), with two differences: a
// permission prompt is the user's to answer, never a turn gone quiet, and a
// prompt Claude Code wrote for itself (a background task's notification) is
// passed over, as the chat passes over it.
func TurnOpen(events []event.Event) bool {
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
		case event.KindToolPre, event.KindToolPost:
			return true
		case event.KindContextCompact:
			if payloadKey(e.Payload, "trigger") == "manual" {
				continue
			}
			return true
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
	return false
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
