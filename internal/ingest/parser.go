// Package ingest discovers Claude Code transcript files (~/.claude/projects/**),
// tails them, and turns their JSONL lines into normalized events. The transcript
// format is not a public contract: the parser is schema-versioned, tolerates
// unknown fields and line types, and skips malformed lines instead of failing.
// See .ai/03-contracts.md § Transcript JSONL (observed shape).
package ingest

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/dspv/caprock/internal/event"
)

// SchemaVersion is bumped whenever the parser's expectations of the transcript
// shape change. Stored with the daemon's meta so a future migration can decide
// whether historical events need re-derivation.
//
// v2 (2026-08-20): assistant text is clipped on runes rather than bytes, at a
// much higher limit. Rows written by v1 may be short and may end in U+FFFD.
const SchemaVersion = 2

// Line is the subset of a transcript line the parser understands.
type Line struct {
	Type        string `json:"type"`
	UUID        string `json:"uuid"`
	ParentUUID  string `json:"parentUuid"`
	SessionID   string `json:"sessionId"`
	PromptID    string `json:"promptId"`
	Cwd         string `json:"cwd"`
	Timestamp   string `json:"timestamp"`
	Version     string `json:"version"`
	GitBranch   string `json:"gitBranch"`
	IsSidechain bool   `json:"isSidechain"`
	AgentID     string `json:"agentId"`
	Subtype     string `json:"subtype"`
	DurationMs  int64  `json:"durationMs"`
	Message     *struct {
		Role    string          `json:"role"`
		Model   string          `json:"model"`
		ID      string          `json:"id"`
		Content json.RawMessage `json:"content"`
		Usage   *struct {
			InputTokens              int64 `json:"input_tokens"`
			OutputTokens             int64 `json:"output_tokens"`
			CacheReadInputTokens     int64 `json:"cache_read_input_tokens"`
			CacheCreationInputTokens int64 `json:"cache_creation_input_tokens"`
			CacheCreation            *struct {
				Ephemeral5m int64 `json:"ephemeral_5m_input_tokens"`
				Ephemeral1h int64 `json:"ephemeral_1h_input_tokens"`
			} `json:"cache_creation"`
		} `json:"usage"`
	} `json:"message"`
}

// ErrSkip marks lines that carry nothing we consume (meta lines, blank lines).
var ErrSkip = errors.New("skip line")

// ErrMalformed marks lines that are not valid JSON objects.
var ErrMalformed = errors.New("malformed line")

// ParseLine decodes one JSONL line. Unknown fields are ignored by encoding/json.
func ParseLine(raw []byte) (*Line, error) {
	raw = bytes.TrimSpace(bytes.TrimPrefix(raw, []byte("\xef\xbb\xbf")))
	if len(raw) == 0 {
		return nil, ErrSkip
	}
	if raw[0] != '{' {
		return nil, ErrMalformed
	}
	var l Line
	if err := json.Unmarshal(raw, &l); err != nil {
		return nil, ErrMalformed
	}
	switch l.Type {
	case "user", "assistant", "system":
		if l.SessionID == "" {
			return nil, ErrSkip
		}
		return &l, nil
	default:
		return nil, ErrSkip
	}
}

// Ts parses the RFC 3339 timestamp; falls back to `fallback` when absent/invalid.
func (l *Line) Ts(fallback time.Time) time.Time {
	if l.Timestamp == "" {
		return fallback
	}
	t, err := time.Parse(time.RFC3339Nano, l.Timestamp)
	if err != nil {
		return fallback
	}
	return t
}

// contentBlock is one element of message.content when it is an array.
type contentBlock struct {
	Type      string          `json:"type"`
	Text      string          `json:"text"`
	ID        string          `json:"id"`          // tool_use
	Name      string          `json:"name"`        // tool_use
	Input     json.RawMessage `json:"input"`       // tool_use
	ToolUseID string          `json:"tool_use_id"` // tool_result
	Content   json.RawMessage `json:"content"`     // tool_result
	IsError   bool            `json:"is_error"`
}

func (l *Line) blocks() []contentBlock {
	if l.Message == nil || len(l.Message.Content) == 0 {
		return nil
	}
	var arr []contentBlock
	if err := json.Unmarshal(l.Message.Content, &arr); err != nil {
		return nil
	}
	return arr
}

// promptText returns the user's typed prompt when the message content is a plain
// string (as opposed to tool_result blocks).
func (l *Line) promptText() (string, bool) {
	if l.Message == nil || len(l.Message.Content) == 0 {
		return "", false
	}
	var s string
	if err := json.Unmarshal(l.Message.Content, &s); err == nil {
		return s, true
	}
	// Some clients send [{type:"text",text:"…"}] for prompts.
	var text []string
	for _, b := range l.blocks() {
		if b.Type == "text" && b.Text != "" {
			text = append(text, b.Text)
		} else if b.Type == "tool_result" {
			return "", false
		}
	}
	if len(text) > 0 {
		return strings.Join(text, "\n"), true
	}
	return "", false
}

// Events converts a parsed line into zero or more normalized events. Keys are
// chosen to collide with the hook shim's keys for the same logical event
// ("pre:<tool_use_id>", "post:<tool_use_id>", "prompt:<prompt_id>"), so whichever
// plane arrives first wins and the other dedupes in the store.
func (l *Line) Events(fallbackTs time.Time) []event.Event {
	ts := l.Ts(fallbackTs)
	var out []event.Event
	base := func(kind event.Kind) event.Event {
		return event.Event{Ts: ts, SessionID: l.SessionID, Source: event.SourceTranscript, Kind: kind, AgentID: l.AgentID}
	}
	switch l.Type {
	case "assistant":
		if l.Message == nil {
			return nil
		}
		if l.Message.Model == "<synthetic>" {
			// Claude Code writes synthetic assistant lines (e.g. error notices) with
			// no real usage; they are not turns and must not skew the model mix.
			return nil
		}
		ev := base(event.KindTurnAssistant)
		ev.Model = l.Message.Model
		// One API response is written as several assistant lines (thinking / text /
		// tool_use blocks), each repeating the same usage object. Keying on the
		// message id makes the store count usage exactly once per response.
		ev.Key = "msg:" + l.Message.ID
		if l.Message.ID == "" {
			ev.Key = "turn:" + l.UUID
		}
		if u := l.Message.Usage; u != nil {
			td := &event.TokenDelta{In: u.InputTokens, Out: u.OutputTokens, CacheRead: u.CacheReadInputTokens, CacheWrite: u.CacheCreationInputTokens}
			if u.CacheCreation != nil {
				td.CacheWrite1h = u.CacheCreation.Ephemeral1h
			}
			ev.Tokens = td
		}
		ev.Payload = assistantPayload(l)
		out = append(out, ev)
		for _, b := range l.blocks() {
			if b.Type != "tool_use" || b.ID == "" {
				continue
			}
			tp := base(event.KindToolPre)
			tp.Tool = b.Name
			tp.Key = "pre:" + b.ID
			tp.Payload = mustJSON(map[string]any{
				"hook_event_name": "PreToolUse", "session_id": l.SessionID, "cwd": l.Cwd,
				"tool_name": b.Name, "tool_input": capRawObj(b.Input, 32<<10), "tool_use_id": b.ID,
				"_from": "transcript",
			})
			out = append(out, tp)
		}
	case "user":
		if text, ok := l.promptText(); ok {
			ev := base(event.KindTurnUser)
			if l.PromptID != "" {
				ev.Key = "prompt:" + l.PromptID
			} else if l.UUID != "" {
				ev.Key = "user:" + l.UUID
			}
			ev.Payload = mustJSON(map[string]any{
				"hook_event_name": "UserPromptSubmit", "session_id": l.SessionID, "cwd": l.Cwd,
				"prompt": text, "prompt_id": l.PromptID, "_from": "transcript",
			})
			out = append(out, ev)
		}
		for _, b := range l.blocks() {
			if b.Type != "tool_result" || b.ToolUseID == "" {
				continue
			}
			tp := base(event.KindToolPost)
			tp.Key = "post:" + b.ToolUseID
			tp.Payload = mustJSON(map[string]any{
				"hook_event_name": "PostToolUse", "session_id": l.SessionID, "cwd": l.Cwd,
				"tool_use_id": b.ToolUseID, "tool_response": capRaw(b.Content, 32<<10), "is_error": b.IsError,
				"_from": "transcript",
			})
			out = append(out, tp)
		}
	case "system":
		// turn_duration etc. are informational; nothing normalized yet.
	}
	return out
}

// MaxAssistantText caps the assistant prose kept per turn. It exists to stop a
// pathological turn from bloating the database, not to summarise: the value is
// well above a normal closing summary so the thing people actually come back
// for — "what changed, and what I still need from you" — is stored whole.
const MaxAssistantText = 16000

// clipRunes truncates to at most n RUNES. The previous cap counted bytes, which
// cut multi-byte prose at roughly half the intended length (Cyrillic is 2 bytes
// per character) and, worse, sliced through the middle of a rune — leaving a
// U+FFFD at the end of 22% of clipped rows. Truncating on a rune boundary is
// the only correct way to shorten UTF-8 text.
func clipRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	count := 0
	for i := range s { // ranging a string yields rune-start byte offsets
		if count == n {
			return s[:i] + "…"
		}
		count++
	}
	return s
}

func assistantPayload(l *Line) json.RawMessage {
	var text []string
	var tools []string
	for _, b := range l.blocks() {
		switch b.Type {
		case "text":
			if t := strings.TrimSpace(b.Text); t != "" {
				text = append(text, t)
			}
		case "tool_use":
			tools = append(tools, b.Name)
		}
	}
	joined := clipRunes(strings.Join(text, "\n"), MaxAssistantText)
	return mustJSON(map[string]any{
		"model": l.Message.Model, "message_id": l.Message.ID, "text": joined, "tools": tools,
		"sidechain": l.IsSidechain, "_from": "transcript",
	})
}

func mustJSON(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		return json.RawMessage(`{}`)
	}
	return b
}

// capRaw keeps payloads bounded: tool results can carry whole files.
func capRaw(r json.RawMessage, max int) json.RawMessage {
	if len(r) == 0 {
		return json.RawMessage(`""`)
	}
	if len(r) <= max {
		return r
	}
	var s string
	if err := json.Unmarshal(r, &s); err == nil {
		return mustJSON(s[:min(len(s), max)] + "…[truncated]")
	}
	return mustJSON("[truncated " + strconvItoa(len(r)) + " bytes]")
}

// capRawObj bounds a tool_input object; oversized inputs (whole-file writes) are
// replaced by a marker object so the row stays small but the tool is still known.
func capRawObj(r json.RawMessage, max int) json.RawMessage {
	if len(r) == 0 {
		return json.RawMessage(`{}`)
	}
	if len(r) <= max {
		return r
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(r, &m); err == nil {
		for k, v := range m {
			if len(v) > 4<<10 {
				m[k] = mustJSON("[truncated " + strconvItoa(len(v)) + " bytes]")
			}
		}
		return mustJSON(m)
	}
	return mustJSON(map[string]string{"_truncated": strconvItoa(len(r)) + " bytes"})
}

func strconvItoa(n int) string { return fmt.Sprintf("%d", n) }
