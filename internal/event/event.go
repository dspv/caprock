// Package event defines the single normalized event type that every part of
// Caprock consumes — the UI, stats, the loop detector, the orchestrator, and any
// future avatar skin. See .ai/02-architecture.md § Event model.
package event

import (
	"encoding/json"
	"time"
)

// Kind is the normalized event kind. Unknown kinds must be tolerated by every
// consumer (logged and ignored, never fatal).
type Kind string

const (
	KindToolPre       Kind = "tool.pre"
	KindToolPost      Kind = "tool.post"
	KindTurnUser      Kind = "turn.user"
	KindTurnAssistant Kind = "turn.assistant"
	KindAgentStop     Kind = "agent.stop"
	KindAgentSpawn    Kind = "agent.spawn"
	// KindSessionEnd is emitted for SessionEnd hooks — the user left the
	// session. It is the only signal that separates "finished" from "quiet",
	// and without it a session stayed live until the staleness sweep caught it
	// half a day later.
	KindSessionEnd        Kind = "session.end"
	KindMailSent          Kind = "mail.sent"
	KindMailDelivered     Kind = "mail.delivered"
	KindTaskCreated       Kind = "task.created"
	KindTaskDone          Kind = "task.done"
	KindApprovalRequested Kind = "approval.requested"
	KindCostTick          Kind = "cost.tick"
	// KindThrottle is emitted for StopFailure hooks (rate_limit / overloaded /
	// billing) — the honest throttle signal for the limit forecast.
	KindThrottle Kind = "throttle"

	// KindContextCompact is emitted for PreCompact hooks (context is about to be
	// summarized). Not in the spec's original list; consumers may ignore it.
	KindContextCompact Kind = "context.compact"
)

// Source says which data plane produced the event.
type Source string

const (
	SourceHook       Source = "hook"
	SourceTranscript Source = "transcript"
	// SourceOpenCode marks events imported from OpenCode's own database. They
	// arrive already priced by OpenCode, so the pricing table is not applied to
	// them; the source is what tells the reader which arithmetic produced a
	// figure.
	SourceOpenCode Source = "opencode"
	SourcePTY      Source = "pty"
	SourceHarness  Source = "harness"
	// SourceGemini marks calls Caprock made to Google's Gemini on the user's
	// own key. Unlike OpenCode these are priced by our own table, because the
	// figures come from the response's usageMetadata and there is no vendor
	// cost to carry — Google reports per project, not per call (ADR-023).
	SourceGemini Source = "gemini"
)

// TokenDelta carries per-turn token usage (turn.assistant only).
type TokenDelta struct {
	In         int64 `json:"in"`
	Out        int64 `json:"out"`
	CacheRead  int64 `json:"cache_read"`
	CacheWrite int64 `json:"cache_write"`
	// CacheWrite1h is the subset of CacheWrite billed at the 1h-TTL rate, when the
	// transcript reports the split. Zero when unknown.
	CacheWrite1h int64 `json:"cache_write_1h,omitempty"`
}

// Total returns all tokens that entered or left the model for this turn.
func (t TokenDelta) Total() int64 { return t.In + t.Out + t.CacheRead + t.CacheWrite }

// Event is the normalized event. ID is assigned by the store (SQLite rowid).
type Event struct {
	ID        int64           `json:"id"`
	Ts        time.Time       `json:"ts"`
	AgentID   string          `json:"agent_id,omitempty"` // harness agent id (Phase 2)
	SessionID string          `json:"session_id"`
	Source    Source          `json:"source"`
	Kind      Kind            `json:"kind"`
	Tool      string          `json:"tool,omitempty"` // for tool.* (Bash, Edit, Read, mcp__…)
	Payload   json.RawMessage `json:"payload"`
	Tokens    *TokenDelta     `json:"tokens,omitempty"`   // for turn.assistant
	CostUSD   *float64        `json:"cost_usd,omitempty"` // for turn.assistant, once priced
	Model     string          `json:"model,omitempty"`    // for turn.assistant
	// Dedupe key: hook payloads carry tool_use_id / prompt_id; transcript lines
	// carry uuid. Same key + same session ⇒ same logical event.
	Key string `json:"key,omitempty"`
	// MsgID is the assistant message this event belongs to. On turn.assistant it
	// is the message whose usage is billed; on tool.pre it is the message whose
	// content block asked for the tool. Equal ids therefore mean "this tool call
	// was paid for by that turn" — the linkage per-directory attribution needs.
	//
	// Empty when unknown, which is the honest answer rather than a guess: the
	// hook plane never sees a message id (the PreToolUse payload does not carry
	// one), so tool calls captured by hooks before the transcript caught up are
	// unlinkable and are reported as such instead of being attributed.
	MsgID string `json:"msg_id,omitempty"`
	// TouchDir is the directory this tool call touched, resolved at ingest from
	// the tool's own input. Empty when the tool named no path.
	TouchDir string `json:"touch_dir,omitempty"`
}
