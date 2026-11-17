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
	"sync"
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
	// postToolUse and afterShellExecution: the call's time in ms.
	Duration float64 `json:"duration"`
	// sessionStart, sessionEnd, subagentStop, afterAgentThought.
	SessionID    string  `json:"session_id"`
	ComposerMode string  `json:"composer_mode"`
	IsBackground bool    `json:"is_background_agent"`
	Reason       string  `json:"reason"`
	FinalStatus  string  `json:"final_status"`
	DurationMs   float64 `json:"duration_ms"`
	// subagentStop. Cursor's docs name no id for the subagent; the fields
	// are read when a build sends them.
	SubagentID    string   `json:"subagent_id"`
	ToolCallID    string   `json:"tool_call_id"`
	SubagentType  string   `json:"subagent_type"`
	Task          string   `json:"task"`
	Description   string   `json:"description"`
	Summary       string   `json:"summary"`
	MessageCount  int      `json:"message_count"`
	ToolCallCount int      `json:"tool_call_count"`
	ModifiedFiles []string `json:"modified_files"`
	// afterShellExecution.
	Command string `json:"command"`
	Output  string `json:"output"`
	// afterFileEdit.
	FilePath string            `json:"file_path"`
	Edits    []json.RawMessage `json:"edits"`
	// user_email, on every hook, is never read: there is no field for it,
	// so it is dropped with the rest of the body (rule 4).
}

// HookEvents are the hooks Caprock registers in hooks.json, in the order
// written. None of them is a permission hook: Cursor blocks an action when a
// permission hook (preToolUse, beforeShellExecution, beforeMCPExecution,
// beforeReadFile, subagentStart) prints nothing valid, and an "allow" from
// one could pass something Cursor would have asked about. Caprock reads; it
// never stands in the way of a decision (rule 3).
//
// sessionStart's reply could set environment variables and add context, and
// subagentStop's and stop's could send a follow-up message; {} does none of
// it. The observational ones added for the CLI's chats (sessionStart,
// sessionEnd, subagentStop, afterShellExecution, afterFileEdit,
// afterAgentThought) are documented as fire-and-forget or decide nothing
// (cursor.com/docs/agent/hooks, read 2026-11-17).
var HookEvents = []string{"beforeSubmitPrompt", "afterAgentResponse", "postToolUse", "postToolUseFailure", "stop", "preCompact",
	"sessionStart", "sessionEnd", "subagentStop", "afterShellExecution", "afterFileEdit", "afterAgentThought"}

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

	mu sync.Mutex
	// thoughts holds afterAgentThought's duration_ms per generation, by a
	// digest of the thought so a repeated hook counts once, until its stop
	// carries their sum.
	thoughts map[string]map[string]int64
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
		capped := event.CapToolField(raw)
		key := p.ToolUseID
		if key == "" {
			key = p.GenerationID + ":" + short(string(p.ToolInput))
		}
		tool := ToolName(p.ToolName)
		if err := rec(&event.Event{Kind: event.KindToolPre, Tool: tool, Key: "cu-hook-pre:" + key, MsgID: "cursor/" + p.GenerationID},
			map[string]any{"tool_name": tool, "tool_input": capped, "cursor_tool": p.ToolName, "tool_use_id": key}); err != nil {
			return err
		}
		if (tool == "Write" || tool == "Edit") && p.Event == "postToolUse" {
			// afterFileEdit records the edit's result with its old and new
			// strings; a second result here would count its lines twice.
			return nil
		}
		fields := map[string]any{"tool_name": tool, "cursor_tool": p.ToolName, "tool_input": capped, "tool_use_id": key}
		evKey := "cu-hook-post:" + key
		var size int64
		if tool == "Bash" {
			// In Claude Code's shape, {stdout}, so the pull-request and
			// branch readers find a `gh pr create` URL and a `git push`.
			// afterShellExecution may carry the same command: both are
			// keyed by it, and the first to arrive is kept.
			cmd, _ := input["command"].(string)
			evKey = shellKey(p.GenerationID, cmd)
			out, code, hasCode := shellOutput(p.ToolOutput)
			resp, _ := json.Marshal(map[string]any{"stdout": out})
			size = int64(len(resp))
			fields["tool_response"] = event.CapToolField(resp)
			if hasCode {
				fields["exit_code"] = code
			}
			fields["is_error"] = p.Event == "postToolUseFailure" || hasCode && code != 0
		} else if len(p.ToolOutput) > 0 {
			size = int64(len(p.ToolOutput))
			fields["tool_response"] = event.CapToolField(p.ToolOutput)
			fields["is_error"] = p.Event == "postToolUseFailure"
		}
		if p.Duration > 0 {
			fields["duration_ms"] = int64(p.Duration)
		}
		if p.Event == "postToolUseFailure" {
			fields["error"] = p.Error
			fields["is_error"] = true
		}
		return rec(&event.Event{Kind: event.KindToolPost, Tool: tool, Key: evKey, ToolBytes: size}, fields)
	case "afterShellExecution":
		if p.Command == "" {
			return nil
		}
		resp, _ := json.Marshal(map[string]any{"stdout": p.Output})
		in, _ := json.Marshal(map[string]any{"command": p.Command})
		fields := map[string]any{"tool_name": "Bash", "cursor_tool": "Shell", "tool_input": json.RawMessage(in),
			"tool_response": event.CapToolField(resp), "is_error": false}
		if p.Duration > 0 {
			fields["duration_ms"] = int64(p.Duration)
		}
		return rec(&event.Event{Kind: event.KindToolPost, Tool: "Bash", Key: shellKey(p.GenerationID, p.Command), ToolBytes: int64(len(resp))}, fields)
	case "afterFileEdit":
		if p.FilePath == "" {
			return nil
		}
		in, _ := json.Marshal(map[string]any{"file_path": absolute(p.FilePath, cwd), "edits": p.Edits})
		capped := event.CapToolField(in)
		return rec(&event.Event{Kind: event.KindToolPost, Tool: "Edit", Key: "cu-hook-edit:" + p.GenerationID + ":" + short(string(in))},
			map[string]any{"tool_name": "Edit", "cursor_tool": "afterFileEdit", "tool_input": capped, "is_error": false})
	case "afterAgentThought":
		// Only how long the model thought, added up per generation for its
		// stop; the thought itself is not stored.
		if p.DurationMs > 0 && p.GenerationID != "" {
			h.addThought(p.GenerationID, short(p.Text), int64(p.DurationMs))
		}
		return nil
	case "stop":
		fields := map[string]any{"status": p.Status, "loop_count": p.LoopCount}
		if ms := h.takeThought(p.GenerationID); ms > 0 {
			fields["thinking_ms"] = ms
		}
		return rec(&event.Event{Kind: event.KindAgentStop, Key: "cu-hook-stop:" + p.GenerationID}, fields)
	case "subagentStop":
		// A subagent's end, as Claude Code's SubagentStop: agent.stop with
		// the subagent's id, and what Cursor says it was and did.
		id := p.SubagentID
		if id == "" {
			id = p.ToolCallID
		}
		if id == "" {
			id = "sub-" + short(p.GenerationID+"\x00"+p.Task+"\x00"+p.Description)
		}
		fields := map[string]any{"status": p.Status, "agent_type": p.SubagentType, "description": firstNonEmpty(p.Description, p.Task),
			"tool_call_count": p.ToolCallCount, "message_count": p.MessageCount}
		if p.DurationMs > 0 {
			fields["duration_ms"] = int64(p.DurationMs)
		}
		if len(p.ModifiedFiles) > 0 {
			fields["modified_files"] = p.ModifiedFiles
		}
		return rec(&event.Event{Kind: event.KindAgentStop, AgentID: id, Key: "cu-hook-substop:" + p.GenerationID + ":" + id}, fields)
	case "sessionStart":
		fields := map[string]any{"composer_mode": p.ComposerMode}
		if m := HookMode(p.ComposerMode); m != "" {
			fields["permission_mode"] = m
		}
		if p.IsBackground {
			fields["background_agent"] = true
		}
		return rec(&event.Event{Kind: event.KindAgentSpawn, Key: "cu-hook-start:" + firstNonEmpty(p.SessionID, p.ConversationID)}, fields)
	case "sessionEnd":
		// Cursor's session ends when its work completed or the person
		// closed it; an abort, an error or a closed window may leave the
		// chat to be taken up again, so they are kept on the timeline only.
		kind := event.KindSessionContinue
		if p.Reason == "completed" || p.Reason == "user_close" {
			kind = event.KindSessionEnd
		}
		fields := map[string]any{"reason": p.Reason, "final_status": p.FinalStatus}
		if p.DurationMs > 0 {
			fields["duration_ms"] = int64(p.DurationMs)
		}
		return rec(&event.Event{Kind: kind, Key: "cu-hook-end:" + firstNonEmpty(p.SessionID, p.ConversationID) + ":" + p.Reason}, fields)
	case "preCompact":
		return rec(&event.Event{Kind: event.KindContextCompact, Key: "cu-hook-compact:" + p.GenerationID},
			map[string]any{"trigger": p.Trigger, "context_tokens": p.ContextTokens, "context_window_size": p.ContextWindow})
	}
	return nil
}

// shellKey keys a terminal command's result by its generation and command:
// postToolUse and afterShellExecution both report it, and only one of them
// carries a call id.
func shellKey(generation, command string) string {
	return "cu-hook-shell:" + generation + ":" + short(command)
}

// shellOutput reads a Shell call's tool_output — a JSON string holding an
// object ({"output": …, "exitCode": n}) — as its output and exit code.
func shellOutput(raw json.RawMessage) (out string, code int, hasCode bool) {
	if len(raw) == 0 {
		return "", 0, false
	}
	var v map[string]any
	if !object(raw, &v) {
		var s string
		if json.Unmarshal(raw, &s) == nil {
			return s, 0, false
		}
		return string(raw), 0, false
	}
	for _, k := range []string{"output", "stdout"} {
		if s, ok := v[k].(string); ok {
			out = s
			break
		}
	}
	for _, k := range []string{"exitCode", "exit_code"} {
		if n, ok := v[k].(float64); ok {
			return out, int(n), true
		}
	}
	return out, 0, false
}

func firstNonEmpty(v ...string) string {
	for _, s := range v {
		if s != "" {
			return s
		}
	}
	return ""
}

// maxThoughts bounds the generations whose thinking is held for their stop:
// a generation whose stop never comes is dropped with the rest.
const maxThoughts = 512

func (h *HookHandler) addThought(gen, digest string, ms int64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.thoughts == nil || len(h.thoughts) >= maxThoughts {
		h.thoughts = map[string]map[string]int64{}
	}
	if h.thoughts[gen] == nil {
		h.thoughts[gen] = map[string]int64{}
	}
	h.thoughts[gen][digest] = ms
}

func (h *HookHandler) takeThought(gen string) int64 {
	h.mu.Lock()
	defer h.mu.Unlock()
	var ms int64
	for _, v := range h.thoughts[gen] {
		ms += v
	}
	delete(h.thoughts, gen)
	return ms
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
