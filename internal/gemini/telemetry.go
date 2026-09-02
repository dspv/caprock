package gemini

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/dspv/caprock/internal/event"
)

// The telemetry file is how Caprock sees a Gemini session at all.
//
// Claude Code has hooks and a transcript; Gemini CLI has neither, and for one
// release Caprock started Gemini sessions and then observed nothing about
// them — a live session sitting in the list with zeroes in every column. What
// it does have is OpenTelemetry, and it will write that to a local file when
// told to (`GEMINI_TELEMETRY_OUTFILE`), which makes the file the equivalent of
// the transcript: something Gemini writes for its own reasons that Caprock is
// allowed to read.
//
// The format is not JSONL. It is a stream of pretty-printed JSON objects
// concatenated with no separator, so the parser tracks brace depth (and string
// state, so a brace inside a prompt does not end a record). Three shapes
// appear:
//
//   - **logs**, carrying `_body` and an `attributes.event.name` — this is where
//     the useful events are: user_prompt, api_response, tool_call.
//   - **spans**, carrying `name` — llm_call, tool_call, schedule_tool_calls.
//     Duplicates what the logs say, with less detail.
//   - **one metrics block** at the end, carrying `scopeMetrics` — session
//     totals, written on exit.
//
// Only the logs are read. The spans repeat them and the metrics arrive too late
// to be live.

// Attribute names, taken from a real telemetry file rather than from the
// bundle. The two are not the same thing: a name in the source may be
// unreachable, and only a real session proves which ones actually appear.
const (
	evUserPrompt  = "gemini_cli.user_prompt"
	evAPIResponse = "gemini_cli.api_response"
	evToolCall    = "gemini_cli.tool_call"
	evConfig      = "gemini_cli.config"
)

// TelemetryEvent is one decoded log record, in Caprock's own terms.
type TelemetryEvent struct {
	Kind      event.Kind
	SessionID string
	TS        time.Time
	// Model is set on api_response and config.
	Model string
	// Tokens, all zero unless this is an api_response.
	TokensIn   int
	TokensOut  int
	CacheRead  int
	Thoughts   int
	ToolTokens int
	// Tool is set on tool_call.
	Tool    string
	Success bool
	// DurationMS is how long the call took, 0 when not applicable.
	DurationMS int
	// Text is the user's prompt on user_prompt. Kept out of every other event
	// so a caller that does not want prose never accidentally holds any.
	Text string
	// Raw is the attributes map, stored as the event payload so a field this
	// parser does not yet read is still there to be read later.
	Raw map[string]any
	// Offset is where this record began, in bytes from the start of the file.
	// Stable across re-reads, which is what makes it usable in a dedupe key —
	// unlike a position within one sweep's batch, which moves when the sweep
	// starts from a different place.
	Offset int64
}

// ParseTelemetry decodes a telemetry stream into events, in file order.
//
// A record that cannot be decoded is skipped rather than failing the read: this
// file is written by another program while Caprock is reading it, so a torn
// final record is the normal case and not an error worth propagating.
func ParseTelemetry(r io.Reader) ([]TelemetryEvent, error) {
	evs, _, err := ParseTelemetryAt(r)
	return evs, err
}

// ParseTelemetryAt is ParseTelemetry, and also reports how many bytes were
// consumed by whole records.
//
// The caller tails a file Gemini is still writing, so the tail is routinely a
// half-written record. Advancing past it loses it: when the writer finishes,
// those bytes are below the stored offset and nothing reads them again. The
// count returned here is the offset just after the last balanced `}` at depth
// zero — everything after it is an incomplete record and will be re-read,
// which costs nothing because the store deduplicates.
func ParseTelemetryAt(r io.Reader) ([]TelemetryEvent, int64, error) {
	var out []TelemetryEvent
	recs, done := recordsAt(r)
	for rec := range recs {
		raw := rec.raw
		var parsed struct {
			Body       any            `json:"_body"`
			Attributes map[string]any `json:"attributes"`
		}
		if err := json.Unmarshal(raw, &parsed); err != nil {
			continue
		}
		// Spans and the metrics block have no _body; they repeat what the logs
		// already carry, in less detail.
		if parsed.Attributes == nil || parsed.Body == nil {
			continue
		}
		if ev, ok := decode(parsed.Attributes); ok {
			ev.Offset = rec.at
			out = append(out, ev)
		}
	}
	return out, <-done, nil
}

func decode(a map[string]any) (TelemetryEvent, bool) {
	name, _ := a["event.name"].(string)
	sid, _ := a["session.id"].(string)
	if sid == "" {
		return TelemetryEvent{}, false
	}
	ev := TelemetryEvent{SessionID: sid, TS: eventTime(a), Raw: a}

	switch name {
	case evUserPrompt:
		ev.Kind = event.KindTurnUser
		ev.Text, _ = a["prompt"].(string)
	case evAPIResponse:
		ev.Kind = event.KindTurnAssistant
		ev.Model, _ = a["model"].(string)
		ev.TokensIn = num(a["input_token_count"])
		ev.TokensOut = num(a["output_token_count"])
		ev.CacheRead = num(a["cached_content_token_count"])
		ev.Thoughts = num(a["thoughts_token_count"])
		ev.ToolTokens = num(a["tool_token_count"])
		ev.DurationMS = num(a["duration_ms"])
	case evToolCall:
		// Gemini reports a tool call once, after it has run — there is no
		// pre-call event to pair with. So this is a tool.post with no
		// tool.pre, which the store already tolerates: an unpaired post is
		// what a transcript-only Claude session produces too.
		ev.Kind = event.KindToolPost
		ev.Tool, _ = a["function_name"].(string)
		ev.Success, _ = a["success"].(bool)
		ev.DurationMS = num(a["duration_ms"])
	case evConfig:
		ev.Kind = event.KindAgentSpawn
		ev.Model, _ = a["model"].(string)
	default:
		return TelemetryEvent{}, false
	}
	return ev, true
}

// eventTime reads Gemini's own timestamp, falling back to now.
//
// Its own is preferred because a poll reads a batch at once: stamping every
// event in the batch with the read time would collapse a minute of work into
// one instant and make the pulse chart lie about when it happened.
func eventTime(a map[string]any) time.Time {
	s, _ := a["event.timestamp"].(string)
	if s == "" {
		return time.Time{}
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05.000Z"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t
		}
	}
	return time.Time{}
}

// num reads a JSON number that may have arrived as a float, a string, or not
// at all. Telemetry writes most counts as numbers and a few as strings, and a
// token count silently read as zero is the failure this whole file exists to
// prevent.
func num(v any) int {
	switch t := v.(type) {
	case float64:
		return int(t)
	case int:
		return t
	case json.Number:
		n, _ := t.Int64()
		return int(n)
	case string:
		var n int
		if _, err := fmt.Sscanf(t, "%d", &n); err == nil {
			return n
		}
	}
	return 0
}

// records yields each top-level JSON object in the stream.
//
// Brace counting, with string and escape state, because the file is
// concatenated pretty-printed objects rather than JSONL — and because a prompt
// containing `{` would otherwise cut a record in half.
// record is one balanced top-level object and where it began.
type record struct {
	at  int64
	raw []byte
}

// recordsAt yields each balanced top-level object, and on a second channel the
// byte offset just past the last complete one.
func recordsAt(r io.Reader) (<-chan record, <-chan int64) {
	ch := make(chan record)
	done := make(chan int64, 1)
	go func() {
		defer close(ch)
		br := bufio.NewReaderSize(r, 64*1024)
		var (
			buf        strings.Builder
			depth      int
			inStr, esc bool
			started    bool
		)
		var read, complete, startedAt int64
		defer func() { done <- complete }()
		for {
			c, err := br.ReadByte()
			if err != nil {
				return
			}
			read++
			if started {
				buf.WriteByte(c)
			}
			switch {
			case inStr:
				if esc {
					esc = false
				} else if c == '\\' {
					esc = true
				} else if c == '"' {
					inStr = false
				}
			case c == '"':
				inStr = true
			case c == '{':
				if depth == 0 {
					started = true
					startedAt = read - 1
					buf.Reset()
					buf.WriteByte(c)
				}
				depth++
			case c == '}':
				depth--
				if depth == 0 && started {
					ch <- record{at: startedAt, raw: []byte(buf.String())}
					buf.Reset()
					started = false
					complete = read
				}
			}
		}
	}()
	return ch, done
}
