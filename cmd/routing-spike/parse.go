package main

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// maxLine bounds one JSONL record. Transcripts embed whole file contents and
// base64 images, so a single line is routinely megabytes.
const maxLine = 64 << 20

// Class is what kind of tool produced an event. The spec's kill criteria are
// stated per class, so this is the axis everything is grouped by.
type Class string

const (
	ClassRead     Class = "read"      // whole-file Read, text
	ClassReadImg  Class = "read_img"  // Read that returned an image
	ClassReadTgt  Class = "read_tgt"  // Read with offset/limit — excluded from routable
	ClassBash     Class = "bash"      //
	ClassMCPText  Class = "mcp_text"  // MCP tool result, text
	ClassMCPImage Class = "mcp_image" // MCP tool result carrying an image
	ClassOther    Class = "other"     // Edit, Write, WebFetch, Agent, ...
)

// Routable reports whether routing to a worker could, in principle, replace
// this event's content with a summary.
//
// Images are never routable: a screenshot is opened in order to be looked at,
// and no worker summary substitutes for that. Targeted reads are excluded by
// the spec because they are what Claude would still do after a delegation.
func (c Class) Routable() bool {
	return c == ClassRead || c == ClassBash || c == ClassMCPText
}

// Event is one tool result, priced in tokens.
type Event struct {
	Class     Class  `json:"class"`
	Tool      string `json:"tool"`
	Project   string `json:"project"`
	Session   string `json:"session"`
	Turn      int    `json:"turn"`       // assistant-turn index within the session
	Tokens    int    `json:"tokens"`     // T: tokens this result added to context
	Estimated bool   `json:"estimated"`  // true when T came from a heuristic, not usage
	Lines     int    `json:"lines"`      // for Read: lines in the result
	Bytes     int    `json:"bytes"`      // only to quantify the bytes-vs-tokens error
	TurnsLeft int    `json:"turns_left"` // assistant turns after this, to the next compaction
	Command   string `json:"command,omitempty"`

	// ContextAtCall is C_i (spec §5.1): the context the issuing assistant turn
	// carried. Exact from usage, never estimated — it is the number the whole
	// context-tax argument rests on.
	ContextAtCall int `json:"context_at_call"`
	// BreaksSeries marks an event that ends a run: a user message or a
	// compaction happened here, so the next call starts a new series.
	BreaksSeries bool `json:"-"`
	// UserBefore is set when a user message preceded this call.
	UserBefore bool `json:"-"`
}

// TokenTurns is the spec's unit: content is written to cache once and re-read
// on every remaining turn, so its cost scales with how early it landed.
func (e Event) TokenTurns() int { return e.Tokens * (1 + e.TurnsLeft) }

// Session is one transcript, reduced to what the estimator needs.
type Session struct {
	Path    string
	Project string
	ID      string
	Events  []Event
	// ContextTokenTurns is the denominator: every token of context, counted
	// once for each assistant turn that had to carry it. Built from the
	// transcript's own usage rather than by summing tool results, so system
	// prompt, CLAUDE.md, user messages and assistant replies are all included.
	ContextTokenTurns int
	AssistantTurns    int
	// BashCalls counts Bash invocations regardless of result size. The owner's
	// impression that "Bash is 60% of spend" comes from per-call attribution,
	// where each call re-sends the whole context; this is the number behind it.
	BashCalls  int
	ToolCalls  int
	Compaction int
	// Model is the session's model id, taken from its assistant turns. The
	// context tax is priced against it, so a session on Opus and one on Sonnet
	// are not interchangeable.
	Model string
}

type rawLine struct {
	Type    string          `json:"type"`
	Subtype string          `json:"subtype"`
	Message json.RawMessage `json:"message"`
	Cwd     string          `json:"cwd"`
	IsMeta  bool            `json:"isMeta"`
}

type rawMessage struct {
	Role    string          `json:"role"`
	Model   string          `json:"model"`
	Content json.RawMessage `json:"content"`
	Usage   *usage          `json:"usage"`
}

type usage struct {
	Input       int `json:"input_tokens"`
	CacheCreate int `json:"cache_creation_input_tokens"`
	CacheRead   int `json:"cache_read_input_tokens"`
	Output      int `json:"output_tokens"`
}

// contextTokens is what the model had to be given for this turn: fresh input
// plus whatever was written to or read from cache. Output is excluded — it is
// produced, not carried.
func (u usage) contextTokens() int { return u.Input + u.CacheCreate + u.CacheRead }

type block struct {
	Type      string          `json:"type"`
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Input     json.RawMessage `json:"input"`
	ToolUseID string          `json:"tool_use_id"`
	Content   json.RawMessage `json:"content"`
}

// ParseSession reads one transcript into events with token costs attached.
func ParseSession(path string) (*Session, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	s := &Session{
		Path:    path,
		Project: projectName(path),
		ID:      strings.TrimSuffix(filepath.Base(path), ".jsonl"),
	}

	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 1<<20), maxLine)

	// pending maps a tool_use id to the call that made it, so a result can be
	// classified by the tool that produced it — the result block itself does
	// not name one.
	type call struct {
		name     string
		targeted bool
		command  string
	}
	pending := map[string]call{}

	// Each assistant turn's context size, in order, plus the turn index at
	// which each compaction happened. Both are needed after the walk: turns_left
	// is only knowable once the session's length is known.
	var turnCtx []int
	var compactAt []int
	// Events are collected with the turn they landed on; T is filled in during
	// the walk, turns_left afterwards.
	var events []Event

	turn := 0
	prevCtx := 0
	curCtx := 0
	// A user message ends a series: the loop is over because a human spoke.
	// Set on the next event so the boundary lands between the two runs.
	userSpoke := false
	// A compaction also ends a series — the context it was paying for is gone.
	compactPending := false

	for sc.Scan() {
		var rl rawLine
		if err := json.Unmarshal(sc.Bytes(), &rl); err != nil {
			continue // a partial or unfamiliar line is skipped, never fatal
		}
		if rl.Type == "system" && rl.Subtype == "compact_boundary" {
			compactAt = append(compactAt, turn)
			compactPending = true
			continue
		}
		if rl.Cwd != "" && s.Project == "" {
			s.Project = filepath.Base(rl.Cwd)
		}
		if len(rl.Message) == 0 {
			continue
		}
		var m rawMessage
		if err := json.Unmarshal(rl.Message, &m); err != nil {
			continue
		}
		var blocks []block
		if len(m.Content) > 0 {
			// Content is either a string (plain text) or an array of blocks.
			_ = json.Unmarshal(m.Content, &blocks)
		}

		switch m.Role {
		case "assistant":
			if s.Model == "" {
				s.Model = m.Model
			}
			ctx := 0
			if m.Usage != nil {
				ctx = m.Usage.contextTokens()
			}
			if ctx > 0 {
				turn++
				curCtx = ctx
				turnCtx = append(turnCtx, ctx)
				// The growth in context since the previous assistant turn is
				// what the intervening tool results cost. Attributed below.
				grew := ctx - prevCtx
				prevCtx = ctx
				attribute(events, grew, turn)
			}
			for _, b := range blocks {
				if b.Type == "tool_use" {
					targeted, cmd := inspectInput(b.Name, b.Input)
					pending[b.ID] = call{name: b.Name, targeted: targeted, command: cmd}
					s.ToolCalls++
					if b.Name == "Bash" {
						s.BashCalls++
					}
				}
			}

		case "user":
			hasResult := false
			for _, b := range blocks {
				if b.Type == "tool_result" {
					hasResult = true
					break
				}
			}
			if !hasResult {
				// A message from the human, not a tool answering back.
				userSpoke = true
			}
			for _, b := range blocks {
				if b.Type != "tool_result" {
					continue
				}
				c := pending[b.ToolUseID]
				text, isImage, nbytes := flatten(b.Content)
				ev := Event{
					Class:         classify(c.name, c.targeted, isImage),
					Tool:          c.name,
					Project:       s.Project,
					Session:       s.ID,
					Turn:          turn,
					Lines:         strings.Count(text, "\n") + 1,
					Bytes:         nbytes,
					Command:       c.command,
					ContextAtCall: curCtx,
					UserBefore:    userSpoke,
					BreaksSeries:  compactPending,
				}
				userSpoke, compactPending = false, false
				events = append(events, ev)
			}
		}
	}
	if err := sc.Err(); err != nil {
		// A single oversized line is survivable; the rest of the file still
		// carries usable events.
		if !strings.Contains(err.Error(), "token too long") {
			return nil, err
		}
	}

	// Any event still without a token count never saw a following assistant
	// turn (the session ended, or usage was absent). Estimate it, and say so.
	for i := range events {
		if events[i].Tokens == 0 {
			events[i].Tokens = estimateTokens(events[i].Bytes)
			events[i].Estimated = true
		}
		events[i].TurnsLeft = turnsLeft(events[i].Turn, turn, compactAt)
	}

	s.Events = events
	s.AssistantTurns = turn
	s.Compaction = len(compactAt)
	for _, c := range turnCtx {
		s.ContextTokenTurns += c
	}
	return s, nil
}

// attribute spreads the context growth between two assistant turns across the
// tool results that caused it.
//
// The spec asks for the delta of input+cache_creation around each result. When
// one turn carries several results — Claude routinely batches them — the delta
// covers all of them at once and cannot be split by measurement, so it is
// apportioned by size. That is a real approximation and the only one here; it
// does not change any total, only how a shared delta is divided within a turn.
func attribute(events []Event, grew, turn int) {
	if grew <= 0 {
		return
	}
	var idx []int
	total := 0
	for i := range events {
		if events[i].Turn == turn-1 && events[i].Tokens == 0 {
			idx = append(idx, i)
			total += events[i].Bytes
		}
	}
	if len(idx) == 0 {
		return
	}
	if total == 0 {
		for _, i := range idx {
			events[i].Tokens = grew / len(idx)
		}
		return
	}
	for _, i := range idx {
		events[i].Tokens = grew * events[i].Bytes / total
	}
}

// turnsLeft counts assistant turns after this event, stopping at the next
// compaction: content discarded by a compaction is not re-read after it.
func turnsLeft(at, last int, compactAt []int) int {
	end := last
	for _, c := range compactAt {
		if c > at {
			end = c
			break
		}
	}
	if end < at {
		return 0
	}
	return end - at
}

// estimateTokens is the fallback when usage cannot supply a figure: roughly
// four characters per token, the standard approximation for English and code.
func estimateTokens(nbytes int) int { return nbytes / 4 }

// flatten renders a tool_result's content to text and reports whether it
// carried an image. Images are counted but never treated as routable.
func flatten(raw json.RawMessage) (text string, isImage bool, nbytes int) {
	if len(raw) == 0 {
		return "", false, 0
	}
	nbytes = len(raw)
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s, false, len(s)
	}
	var parts []block
	if json.Unmarshal(raw, &parts) == nil {
		var b strings.Builder
		for _, p := range parts {
			switch p.Type {
			case "image":
				isImage = true
			case "text":
				var t struct {
					Text string `json:"text"`
				}
				if json.Unmarshal(raw, &t) == nil {
					b.WriteString(t.Text)
				}
			}
		}
		if b.Len() > 0 {
			return b.String(), isImage, nbytes
		}
		// Text could not be extracted block-by-block; the raw JSON is still a
		// fair proxy for how much content there was.
		return string(raw), isImage, nbytes
	}
	return string(raw), false, nbytes
}

// inspectInput reports whether a Read is targeted (offset/limit present, which
// the spec excludes) and extracts a Bash command for classification.
func inspectInput(name string, raw json.RawMessage) (targeted bool, command string) {
	if len(raw) == 0 {
		return false, ""
	}
	var in struct {
		Offset  *int   `json:"offset"`
		Limit   *int   `json:"limit"`
		Command string `json:"command"`
	}
	if json.Unmarshal(raw, &in) != nil {
		return false, ""
	}
	if name == "Read" {
		return in.Offset != nil || in.Limit != nil, ""
	}
	return false, in.Command
}

func classify(tool string, targeted, isImage bool) Class {
	switch {
	case tool == "Read" && targeted:
		return ClassReadTgt
	case tool == "Read" && isImage:
		return ClassReadImg
	case tool == "Read":
		return ClassRead
	case tool == "Bash":
		return ClassBash
	case strings.HasPrefix(tool, "mcp__") && isImage:
		return ClassMCPImage
	case strings.HasPrefix(tool, "mcp__"):
		return ClassMCPText
	default:
		return ClassOther
	}
}

// projectName recovers a readable project from Claude Code's flattened
// directory names (`-Users-ds-dev-caprock` -> `caprock`).
func projectName(path string) string {
	d := filepath.Base(filepath.Dir(path))
	d = strings.TrimPrefix(d, "-")
	if i := strings.LastIndex(d, "-"); i >= 0 && i < len(d)-1 {
		return d[i+1:]
	}
	return d
}
