// Package hookd receives Claude Code hook payloads from the caprock-hook shim on
// POST /v1/hook, normalizes them into events, and hands them to the recorder.
// Unknown events and fields are logged and ignored, never fatal.
package hookd

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/rollup"
)

// MaxBody bounds a hook payload. tool_response can be large; 4 MiB is generous.
const MaxBody = 4 << 20

// Payload is the subset of hook JSON that hookd reads. The raw body is stored
// untouched as the event payload, so nothing here limits what the UI can show.
type Payload struct {
	SessionID      string          `json:"session_id"`
	PromptID       string          `json:"prompt_id"`
	TranscriptPath string          `json:"transcript_path"`
	Cwd            string          `json:"cwd"`
	HookEventName  string          `json:"hook_event_name"`
	PermissionMode string          `json:"permission_mode"`
	AgentID        string          `json:"agent_id"`
	AgentType      string          `json:"agent_type"`
	ToolName       string          `json:"tool_name"`
	ToolInput      json.RawMessage `json:"tool_input"`
	ToolUseID      string          `json:"tool_use_id"`
	Prompt         string          `json:"prompt"`
	StopReason     string          `json:"stop_reason"`
	Source         string          `json:"source"`  // SessionStart
	Model          string          `json:"model"`   // SessionStart (optional)
	Trigger        string          `json:"trigger"` // PreCompact
	Reason         string          `json:"reason"`  // SessionEnd
	Error          string          `json:"error"`   // StopFailure / PostToolUseFailure
}

// endsTheSession reports whether a SessionEnd reason means the session is over.
//
// SessionEnd does not only mean "the user left". Observed on a real machine:
// `clear` (the user ran /clear — same session, fresh context) and
// `prompt_input_exit` (Escape at the prompt), alongside `exit` and `other`.
// Treating all of them as the end retired sessions people were still working
// in: one here had been running for six days when a /clear closed it.
//
// The reasons known to continue are named, plus `other` — which is not a
// statement that the session ended, and is too thin to retire someone's work
// on. Everything else ends it. The idle sweep is the backstop in both
// directions, and the two errors are not symmetric: a session wrongly left
// open closes itself within the hour, while one wrongly closed vanishes from
// the dashboard with its owner still typing into it. A real exit is also
// caught by the process exiting, which records the code and ends the session
// through a path that does not depend on this reason at all.
func endsTheSession(reason string) bool {
	switch reason {
	case "clear", "prompt_input_exit", "other":
		return false
	default:
		return true
	}
}

// ErrUnknownEvent marks hook_event_name values hookd does not consume.
var ErrUnknownEvent = errors.New("unknown hook event")

// ErrNoSession marks payloads without a session_id — nothing to attach them to.
var ErrNoSession = errors.New("hook payload without session_id")

// Normalize converts a raw hook payload into an Event plus what it reveals about
// the session. The event's Payload is the raw body verbatim.
func Normalize(raw []byte, now time.Time) (*event.Event, rollup.SessionInfo, error) {
	var p Payload
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, rollup.SessionInfo{}, err
	}
	if p.SessionID == "" {
		return nil, rollup.SessionInfo{}, ErrNoSession
	}
	info := rollup.SessionInfo{Cwd: p.Cwd, TranscriptPath: p.TranscriptPath, Model: p.Model}
	ev := &event.Event{
		Ts:        now,
		SessionID: p.SessionID,
		Source:    event.SourceHook,
		Payload:   json.RawMessage(raw),
		AgentID:   p.AgentID,
	}
	switch p.HookEventName {
	case "PreToolUse":
		ev.Kind, ev.Tool = event.KindToolPre, p.ToolName
		ev.Key = keyOr("pre:"+p.ToolUseID, p.ToolUseID)
	case "PostToolUse":
		ev.Kind, ev.Tool = event.KindToolPost, p.ToolName
		ev.Key = keyOr("post:"+p.ToolUseID, p.ToolUseID)
	case "UserPromptSubmit":
		ev.Kind = event.KindTurnUser
		ev.Key = keyOr("prompt:"+p.PromptID, p.PromptID)
	case "Stop":
		ev.Kind = event.KindAgentStop
	case "SubagentStop":
		ev.Kind = event.KindAgentStop
		if ev.AgentID == "" {
			ev.AgentID = "subagent"
		}
	case "SessionStart":
		ev.Kind = event.KindAgentSpawn
	case "SessionEnd":
		// Claude Code fires this for several things, and most of them leave the
		// session running: `clear` wipes the context, `prompt_input_exit` is
		// Escape at the prompt. Treating every one as "the session is over"
		// retired sessions their owner was still working in — one here had run
		// for six days before a /clear closed it in the dashboard.
		//
		// Only an exit ends it. Anything else is recorded as an ordinary event
		// so the timeline still shows it, and the idle sweep decides the rest.
		if !endsTheSession(p.Reason) {
			// Still worth recording: `/clear` is a context reset, which is what
			// context.compact already means, and the timeline should show it.
			// What it must not do is retire the session.
			ev.Kind = event.KindContextCompact
			break
		}
		ev.Kind = event.KindSessionEnd
	case "PreCompact":
		ev.Kind = event.KindContextCompact
	case "StopFailure":
		// A turn failed to complete — rate_limit / overloaded / billing etc. This
		// is the honest throttle signal (SPEC §8.4 / throttle_observations).
		ev.Kind = event.KindThrottle
	default:
		return nil, info, ErrUnknownEvent
	}
	return ev, info, nil
}

func keyOr(key, id string) string {
	if id == "" {
		return ""
	}
	return key
}

// Recorder is what hookd needs from rollup (interface for tests).
type Recorder interface {
	Record(ctx context.Context, ev *event.Event, info rollup.SessionInfo) (rollup.Result, error)
}

// Handler serves POST /v1/hook.
type Handler struct {
	Token    string
	Recorder Recorder
	Log      *slog.Logger
	Now      func() time.Time
	// OnAccepted is called after a successful record (loop detector hook-in).
	OnAccepted func(res rollup.Result)
	// Decide answers Stop events (Phase 2). nil ⇒ empty 204 reply.
	Decide func(ctx context.Context, p Payload) []byte
}

// ServeHTTP implements the contract: bearer-token gated, 204 on success,
// 401 on bad token, 400 on unparsable body, 200 with a JSON body only for
// Stop decisions (Phase 2). Unknown events return 204 (ignored, logged).
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	log := h.Log
	if log == nil {
		log = slog.Default()
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !h.authorized(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, MaxBody+1))
	if err != nil {
		http.Error(w, "read body", http.StatusBadRequest)
		return
	}
	if len(body) > MaxBody {
		http.Error(w, "payload too large", http.StatusRequestEntityTooLarge)
		return
	}
	now := time.Now()
	if h.Now != nil {
		now = h.Now()
	}
	ev, info, err := Normalize(body, now)
	switch {
	case errors.Is(err, ErrUnknownEvent):
		var p Payload
		_ = json.Unmarshal(body, &p)
		log.Info("ignoring unknown hook event", "component", "hookd", "event", p.HookEventName, "session_id", p.SessionID)
		w.WriteHeader(http.StatusNoContent)
		return
	case errors.Is(err, ErrNoSession):
		log.Warn("hook payload without session_id", "component", "hookd")
		w.WriteHeader(http.StatusNoContent)
		return
	case err != nil:
		log.Warn("bad hook payload", "component", "hookd", "err", err)
		http.Error(w, "bad payload", http.StatusBadRequest)
		return
	}
	res, err := h.Recorder.Record(r.Context(), ev, info)
	if err != nil {
		log.Error("record hook event", "component", "hookd", "err", err, "session_id", ev.SessionID, "kind", ev.Kind)
		http.Error(w, "store", http.StatusInternalServerError)
		return
	}
	if res.Stored && h.OnAccepted != nil {
		h.OnAccepted(res)
	}
	if ev.Kind == event.KindAgentStop && ev.AgentID == "" && h.Decide != nil {
		var p Payload
		_ = json.Unmarshal(body, &p)
		if reply := h.Decide(r.Context(), p); len(reply) > 0 {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(reply)
			return
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) authorized(r *http.Request) bool {
	if h.Token == "" {
		return false
	}
	auth := r.Header.Get("Authorization")
	const prefix = "Bearer "
	if !strings.HasPrefix(auth, prefix) {
		return false
	}
	got := strings.TrimSpace(auth[len(prefix):])
	return subtle.ConstantTimeCompare([]byte(got), []byte(h.Token)) == 1
}
