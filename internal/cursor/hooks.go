package cursor

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/ingest"
	"github.com/dspv/caprock/internal/rollup"
	"github.com/dspv/caprock/internal/sessionlink"
)

// HookPayload is the part of a Cursor hook's input Caprock reads, from
// cursor.com/docs/agent/hooks (read 2026-11-16). Every hook carries the
// common fields; the rest belong to one event each.
type HookPayload struct {
	ConversationID string   `json:"conversation_id"`
	GenerationID   string   `json:"generation_id"`
	Model          string   `json:"model"`
	ModelID        string   `json:"model_id"`
	Event          string   `json:"hook_event_name"`
	CursorVersion  string   `json:"cursor_version"`
	WorkspaceRoots []string `json:"workspace_roots"`
	TranscriptPath string   `json:"transcript_path"`

	Prompt     string          `json:"prompt"`      // beforeSubmitPrompt
	Text       string          `json:"text"`        // afterAgentResponse
	ToolName   string          `json:"tool_name"`   // postToolUse, postToolUseFailure
	ToolInput  json.RawMessage `json:"tool_input"`  // an object, or a JSON string
	ToolOutput json.RawMessage `json:"tool_output"` // a JSON string
	ToolUseID  string          `json:"tool_use_id"`
	Cwd        string          `json:"cwd"`
	Error      string          `json:"error_message"`
	Status     string          `json:"status"` // stop
	LoopCount  int             `json:"loop_count"`
	// preCompact
	Trigger       string `json:"trigger"`
	ContextTokens int64  `json:"context_tokens"`
	ContextWindow int64  `json:"context_window_size"`
}

// HookEvents are the hooks Caprock registers in hooks.json, in the order
// written. None of them is a permission hook: Cursor blocks an action when a
// permission hook (preToolUse, beforeShellExecution, beforeMCPExecution,
// beforeReadFile, subagentStart) prints nothing valid, and an "allow" from
// one could pass something Cursor would have asked about. Caprock reads; it
// never stands in the way of a decision (rule 3).
var HookEvents = []string{"beforeSubmitPrompt", "afterAgentResponse", "postToolUse", "postToolUseFailure", "stop", "preCompact"}

// NeutralReply is what the shim prints for a hook: the answer that leaves
// Cursor doing exactly what it would have done without Caprock.
// beforeSubmitPrompt's is {"continue": true}; every other registered hook
// takes {} as "nothing to add".
func NeutralReply(event string) []byte {
	if event == "beforeSubmitPrompt" {
		return []byte(`{"continue":true}`)
	}
	return []byte(`{}`)
}

// EnvSession is the variable a Cursor CLI started by Caprock carries: the
// Caprock session it belongs to. Cursor runs hooks as its own children, and
// the shim sends it on, so the chat is linked exactly rather than by folder
// and time.
const EnvSession = "CAPROCK_CURSOR_SESSION"

// Recorder is what the hook handler needs from rollup.
type Recorder interface {
	Record(ctx context.Context, ev *event.Event, info rollup.SessionInfo) (rollup.Result, error)
}

// HookHandler serves POST /v1/hook/cursor.
//
// An editor chat is the editor reader's: its database has the words, the
// tokens and the cost, and a second copy from hooks would show every prompt
// twice. So a hook for a chat the editor's database holds is answered and
// dropped, and hooks record only what no database of Cursor's gives Caprock
// — the `cursor-agent` CLI, whose chats are stored as content-addressed
// protobuf blobs (.ai/25-cursor.md § The CLI).
type HookHandler struct {
	Token    string
	Recorder Recorder
	Log      *slog.Logger
	// Editor reports whether the editor's database holds a chat; nil when
	// there is no editor database, so every hook is recorded.
	Editor func(id string) bool
	Link   *sessionlink.Linker
	Now    func() time.Time
}

func (h *HookHandler) authorized(r *http.Request) bool {
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

// ServeHTTP records one hook. It answers 204 whatever it did with it: the
// shim has already printed Cursor's neutral reply and is not waiting for a
// decision.
func (h *HookHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	log := h.Log
	if log == nil {
		log = slog.Default()
	}
	if !h.authorized(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 4<<20))
	if err != nil {
		http.Error(w, "read body", http.StatusBadRequest)
		return
	}
	var p HookPayload
	if err := json.Unmarshal(body, &p); err != nil {
		http.Error(w, "bad payload", http.StatusBadRequest)
		return
	}
	now := time.Now()
	if h.Now != nil {
		now = h.Now()
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 30*time.Second)
	defer cancel()
	if err := h.handle(ctx, p, r.Header.Get("X-Caprock-Session"), now); err != nil {
		log.Warn("cursor hook not recorded", "component", "cursor", "event", p.Event, "err", err)
	}
	w.WriteHeader(http.StatusNoContent)
}

// handle turns one hook into events. spawned is the Caprock session the
// shim's environment named, "" for a chat Caprock did not start.
func (h *HookHandler) handle(ctx context.Context, p HookPayload, spawned string, now time.Time) error {
	if p.ConversationID == "" {
		return nil
	}
	if spawned == "" && h.Editor != nil && h.Editor(p.ConversationID) {
		return nil // the editor reader has it
	}
	cwd := p.Cwd
	if len(p.WorkspaceRoots) > 0 && p.WorkspaceRoots[0] != "" {
		cwd = p.WorkspaceRoots[0]
	}
	sid := p.ConversationID
	if h.Link != nil {
		if spawned != "" {
			h.Link.Claim(ctx, Agent, spawned, p.ConversationID)
			sid = spawned
		} else {
			sid = h.Link.Resolve(ctx, Agent, sessionlink.Candidate{NativeID: p.ConversationID, Cwd: cwd, Started: now, Eligible: true})
		}
	} else if spawned != "" {
		sid = spawned
	}
	model := p.Model
	if model == "" {
		model = p.ModelID
	}
	info := rollup.SessionInfo{Cwd: cwd, Model: model, Agent: Agent}
	// "cli" when the chat is surely the CLI's: Caprock started it, or the
	// editor's database is read and does not hold it. "hook" when no editor
	// database is read, so it may be either.
	surface := "cli"
	if spawned == "" && h.Editor == nil {
		surface = "hook"
	}
	base := func(f map[string]any) map[string]any {
		f["cursor_surface"] = surface
		f["cwd"] = cwd
		if p.CursorVersion != "" {
			f["cursor_version"] = p.CursorVersion
		}
		return f
	}
	rec := func(ev *event.Event, fields map[string]any) error {
		ev.Ts, ev.SessionID, ev.Source = now, sid, event.SourceCursor
		ev.Payload, _ = json.Marshal(base(fields))
		_, err := h.Recorder.Record(ctx, ev, info)
		return err
	}
	switch p.Event {
	case "beforeSubmitPrompt":
		if p.Prompt == "" {
			return nil
		}
		return rec(&event.Event{Kind: event.KindTurnUser, Key: "cu-hook-prompt:" + p.GenerationID + ":" + short(p.Prompt)},
			map[string]any{"prompt": ingest.ClipAssistantText(p.Prompt), "model": model})
	case "afterAgentResponse":
		if p.Text == "" {
			return nil
		}
		// No tokens: no hook reports usage (.ai/25-cursor.md § The CLI).
		return rec(&event.Event{Kind: event.KindTurnAssistant, Model: model, MsgID: "cursor/" + p.GenerationID,
			Key: "cu-hook-reply:" + p.GenerationID + ":" + short(p.Text)},
			map[string]any{"text": ingest.ClipAssistantText(p.Text), "model": model, "cost_basis": "none"})
	case "postToolUse", "postToolUseFailure":
		if p.ToolName == "" {
			return nil
		}
		input := toolArgs(p.ToolInput)
		raw, _ := json.Marshal(ToolInput(p.ToolName, input, cwd))
		key := p.ToolUseID
		if key == "" {
			key = p.GenerationID + ":" + short(string(p.ToolInput))
		}
		tool := ToolName(p.ToolName)
		if err := rec(&event.Event{Kind: event.KindToolPre, Tool: tool, Key: "cu-hook-pre:" + key, MsgID: "cursor/" + p.GenerationID},
			map[string]any{"tool_name": tool, "tool_input": event.CapToolField(raw), "cursor_tool": p.ToolName}); err != nil {
			return err
		}
		fields := map[string]any{"tool_name": tool, "cursor_tool": p.ToolName}
		if len(p.ToolOutput) > 0 {
			fields["tool_response"] = event.CapToolField(p.ToolOutput)
		}
		if p.Event == "postToolUseFailure" {
			fields["error"] = p.Error
		}
		return rec(&event.Event{Kind: event.KindToolPost, Tool: tool, Key: "cu-hook-post:" + key}, fields)
	case "stop":
		return rec(&event.Event{Kind: event.KindAgentStop, Key: "cu-hook-stop:" + p.GenerationID},
			map[string]any{"status": p.Status, "loop_count": p.LoopCount})
	case "preCompact":
		return rec(&event.Event{Kind: event.KindContextCompact, Key: "cu-hook-compact:" + p.GenerationID},
			map[string]any{"trigger": p.Trigger, "context_tokens": p.ContextTokens, "context_window_size": p.ContextWindow})
	}
	return nil
}

// toolArgs reads tool_input, which the docs give as an object for one hook
// and a JSON string for another.
func toolArgs(raw json.RawMessage) map[string]any {
	if len(raw) == 0 {
		return map[string]any{}
	}
	var m map[string]any
	if json.Unmarshal(raw, &m) == nil && m != nil {
		return m
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return arguments(s)
	}
	return map[string]any{}
}

// short is a stable 12-character digest, for a key.
func short(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:6])
}
