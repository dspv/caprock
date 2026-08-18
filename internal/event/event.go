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
	KindToolPre           Kind = "tool.pre"
	KindToolPost          Kind = "tool.post"
	KindTurnUser          Kind = "turn.user"
	KindTurnAssistant     Kind = "turn.assistant"
	KindAgentStop         Kind = "agent.stop"
	KindAgentSpawn        Kind = "agent.spawn"
	KindMailSent          Kind = "mail.sent"
	KindMailDelivered     Kind = "mail.delivered"
	KindTaskCreated       Kind = "task.created"
	KindTaskDone          Kind = "task.done"
	KindApprovalRequested Kind = "approval.requested"
	KindCostTick          Kind = "cost.tick"
	// KindContextCompact is emitted for PreCompact hooks (context is about to be
	// summarized). Not in the spec's original list; consumers may ignore it.
	KindContextCompact Kind = "context.compact"
)

// Source says which data plane produced the event.
type Source string

const (
	SourceHook       Source = "hook"
	SourceTranscript Source = "transcript"
	SourcePTY        Source = "pty"
	SourceHarness    Source = "harness"
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
}
