// Package codex reads OpenAI Codex's session transcripts.
//
// Codex is the easiest of the three agents to observe. It writes one JSONL
// "rollout" file per session under ~/.codex/sessions/YYYY/MM/DD/, and that file
// already carries everything Caprock stores: the session id and working
// directory, the model, per-turn token counts split by kind, tool calls with
// their arguments, and the plan-limit windows. Nothing has to be installed,
// no config is rewritten, and no process is signalled — the observation is a
// read of files Codex was going to write anyway.
//
// The two things worth knowing before changing anything here were measured
// against 100 real transcripts, not inferred from documentation:
//
//   - `token_count` carries both a running `total_token_usage` and a per-turn
//     `last_token_usage`, and the same values are frequently emitted twice in a
//     row. Summing `last` therefore double-counts: on one real session it gave
//     261,111 tokens against a true 137,739. Deltas are taken from the
//     *cumulative* field instead, which is monotonic in every transcript
//     checked and reproduces the final total exactly on all 92 sessions that
//     carry one.
//
//   - Codex reports tokens but never a cost. Unlike OpenCode, whose own figure
//     Caprock carries through, Codex sessions are priced by our own table —
//     which is why pricing.json had to grow OpenAI rows (see
//     .ai/19-codex.md and pricing/pricing.json).
package codex

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// maxLine bounds one JSONL record. Codex embeds whole file contents in tool
// output, so a rollout line is occasionally very large; this is generous enough
// for real transcripts and still refuses a runaway.
const maxLine = 8 << 20

// Dir is the root Codex writes its rollout transcripts under.
//
// It is the same path on every platform: Codex uses the home directory
// directly, with no XDG or %APPDATA% branching, so there is nothing to switch
// on here. CAPROCK_CODEX_DIR overrides it for tests and for anyone whose Codex
// lives somewhere unusual.
func Dir() string {
	if d := strings.TrimSpace(os.Getenv(EnvDir)); d != "" {
		return d
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".codex", "sessions")
}

// EnvDir overrides the transcript root.
const EnvDir = "CAPROCK_CODEX_DIR"

// Session is one Codex rollout transcript, parsed.
type Session struct {
	ID         string
	Path       string
	Cwd        string
	Model      string
	CLIVersion string
	// Originator is what launched the session ("Codex Desktop", "codex_cli_rs").
	// Kept because a desktop session and a terminal session are different
	// things to a reader looking at where their money went.
	Originator string
	StartedAt  time.Time
	Turns      []Turn
	Tools      []ToolCall
	// Limits is the most recent plan-limit sample in the transcript, when the
	// session carried one.
	Limits *Limits
}

// Turn is one assistant turn's token usage, already reduced to a delta.
type Turn struct {
	At time.Time
	// Key is stable across re-reads: the transcript is append-only, so the
	// ordinal of the record that produced the turn identifies it forever.
	Key        string
	In         int64
	CacheRead  int64
	CacheWrite int64
	Out        int64
	// Reasoning tokens are billed as output and are already included in Out.
	// Carried separately only so a reader can see the split.
	Reasoning int64
}

// ToolCall is one tool invocation.
type ToolCall struct {
	At   time.Time
	Key  string
	Name string
	// Input is the raw argument payload, stored so the dashboard can show what
	// a call actually did.
	Input string
}

// Limits is a plan-limit sample. Codex reports the same two windows Claude Code
// does, in minutes rather than by name.
type Limits struct {
	At               time.Time
	PrimaryPct       float64
	PrimaryMinutes   int
	PrimaryResets    int64
	SecondaryPct     float64
	SecondaryMinutes int
	SecondaryResets  int64
}

// record is one line of a rollout file. Only the fields Caprock uses are named;
// everything else in the payload is ignored rather than rejected, because Codex
// adds event kinds between releases and an unknown kind is not an error.
type record struct {
	Timestamp string          `json:"timestamp"`
	Type      string          `json:"type"`
	Payload   json.RawMessage `json:"payload"`
}

type payloadKind struct {
	Type string `json:"type"`
}

type sessionMeta struct {
	SessionID  string `json:"session_id"`
	ID         string `json:"id"`
	Timestamp  string `json:"timestamp"`
	Cwd        string `json:"cwd"`
	CLIVersion string `json:"cli_version"`
	Originator string `json:"originator"`
	// BaseInstructions carries the model the session's system prompt was
	// built for, which is the only place most transcripts name a model at all.
	BaseInstructions *struct {
		Provenance *struct {
			Type  string `json:"type"`
			Model string `json:"model"`
		} `json:"provenance"`
	} `json:"base_instructions"`
}

type turnContext struct {
	Model string `json:"model"`
	Cwd   string `json:"cwd"`
}

type usage struct {
	InputTokens          int64 `json:"input_tokens"`
	CachedInputTokens    int64 `json:"cached_input_tokens"`
	CacheWriteInputTok   int64 `json:"cache_write_input_tokens"`
	OutputTokens         int64 `json:"output_tokens"`
	ReasoningOutputToken int64 `json:"reasoning_output_tokens"`
	TotalTokens          int64 `json:"total_tokens"`
}

type tokenCount struct {
	Info *struct {
		Total *usage `json:"total_token_usage"`
		Last  *usage `json:"last_token_usage"`
	} `json:"info"`
	RateLimits *struct {
		Primary   *window `json:"primary"`
		Secondary *window `json:"secondary"`
	} `json:"rate_limits"`
}

type window struct {
	UsedPercent   float64 `json:"used_percent"`
	WindowMinutes int     `json:"window_minutes"`
	ResetsAt      int64   `json:"resets_at"`
}

type toolCallPayload struct {
	Name  string          `json:"name"`
	Input json.RawMessage `json:"input"`
	// A function_call spells its arguments differently from a custom_tool_call.
	Arguments json.RawMessage `json:"arguments"`
}

// ParseFile reads one rollout transcript.
//
// A malformed line is skipped rather than failing the file: these are written
// by another program while it runs, so the last line of a live session is
// routinely a partial write, and refusing the whole transcript for it would
// mean a session is invisible until it ends.
func ParseFile(path string) (*Session, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return Parse(f, path)
}

// Parse reads a rollout transcript from r. path is used only for the returned
// Session's Path field.
func Parse(r io.Reader, path string) (*Session, error) {
	s := &Session{Path: path}
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64<<10), maxLine)

	// prevTotal tracks the running cumulative token count so each turn can be
	// stored as a delta. See the package doc for why the transcript's own
	// per-turn field is not used.
	var prevTotal *usage
	var lineNo int64
	for sc.Scan() {
		line := sc.Bytes()
		lineNo++
		if len(line) == 0 {
			continue
		}
		var rec record
		if err := json.Unmarshal(line, &rec); err != nil {
			continue // partial or malformed line: skip, do not fail the file
		}
		at := parseTime(rec.Timestamp)
		switch rec.Type {
		case "session_meta":
			var m sessionMeta
			if err := json.Unmarshal(rec.Payload, &m); err != nil {
				continue
			}
			s.ID = firstNonEmpty(m.SessionID, m.ID)
			s.Cwd = m.Cwd
			s.CLIVersion = m.CLIVersion
			s.Originator = m.Originator
			// The model, from the one place nearly every transcript records
			// it. `turn_context` is the obvious source and is present in only
			// 4 of 100 real transcripts; this is present in 96, and the two
			// sets barely overlap — together they name a model for every
			// session that has any tokens at all.
			//
			// It is a recorded model id (`{"type":"model","model":"…"}`), not
			// an inference from the originator or the CLI version, which is
			// what makes pricing from it honest rather than a guess.
			if bi := m.BaseInstructions; bi != nil && bi.Provenance != nil && bi.Provenance.Type == "model" {
				s.Model = bi.Provenance.Model
			}
			if t := parseTime(m.Timestamp); !t.IsZero() {
				s.StartedAt = t
			} else {
				s.StartedAt = at
			}
		case "turn_context":
			var tc turnContext
			if err := json.Unmarshal(rec.Payload, &tc); err != nil {
				continue
			}
			// turn_context wins over the base-instructions provenance when both
			// are present: provenance describes the prompt the session was
			// built with, this describes the turn actually being run. They
			// agreed in every transcript where both appear, and no model
			// changed mid-session in any of the 100 checked — but if one ever
			// does, the per-turn value is the truthful one.
			if tc.Model != "" {
				s.Model = tc.Model
			}
			if s.Cwd == "" {
				s.Cwd = tc.Cwd
			}
		case "event_msg":
			var k payloadKind
			if err := json.Unmarshal(rec.Payload, &k); err != nil {
				continue
			}
			if k.Type != "token_count" {
				continue
			}
			var tc tokenCount
			if err := json.Unmarshal(rec.Payload, &tc); err != nil {
				continue
			}
			if tc.RateLimits != nil {
				l := &Limits{At: at}
				if w := tc.RateLimits.Primary; w != nil {
					l.PrimaryPct, l.PrimaryMinutes, l.PrimaryResets = w.UsedPercent, w.WindowMinutes, w.ResetsAt
				}
				if w := tc.RateLimits.Secondary; w != nil {
					l.SecondaryPct, l.SecondaryMinutes, l.SecondaryResets = w.UsedPercent, w.WindowMinutes, w.ResetsAt
				}
				s.Limits = l
			}
			if tc.Info == nil || tc.Info.Total == nil {
				continue
			}
			d, ok := delta(prevTotal, tc.Info.Total)
			cur := *tc.Info.Total
			prevTotal = &cur
			if !ok {
				continue // a repeat of the previous sample: no new tokens
			}
			s.Turns = append(s.Turns, Turn{
				At:         at,
				Key:        keyFor(lineNo, "turn"),
				In:         d.InputTokens,
				CacheRead:  d.CachedInputTokens,
				CacheWrite: d.CacheWriteInputTok,
				Out:        d.OutputTokens,
				Reasoning:  d.ReasoningOutputToken,
			})
		case "response_item":
			var k payloadKind
			if err := json.Unmarshal(rec.Payload, &k); err != nil {
				continue
			}
			if k.Type != "custom_tool_call" && k.Type != "function_call" {
				continue
			}
			var tp toolCallPayload
			if err := json.Unmarshal(rec.Payload, &tp); err != nil {
				continue
			}
			in := tp.Input
			if len(in) == 0 {
				in = tp.Arguments
			}
			s.Tools = append(s.Tools, ToolCall{
				At:    at,
				Key:   keyFor(lineNo, "tool"),
				Name:  tp.Name,
				Input: string(in),
			})
		}
	}
	if err := sc.Err(); err != nil && !errors.Is(err, bufio.ErrTooLong) {
		// ErrTooLong is survivable: one oversized line is dropped, and the rest
		// of the transcript is still worth having.
		return nil, err
	}
	if s.ID == "" {
		// No session_meta means this is not a rollout file we understand.
		return nil, ErrNotASession
	}
	return s, nil
}

// ErrNotASession is returned for a file with no session_meta record.
var ErrNotASession = errors.New("codex: not a rollout transcript")

// delta returns the per-turn usage between two cumulative samples, and whether
// there was any. Codex emits the same cumulative figures twice in a row often
// enough that ignoring the repeat is the difference between a correct total and
// one nearly double it.
//
// A total that goes *backwards* is treated as a fresh start rather than a
// negative delta: it has not been observed in any real transcript, but a
// negative token count would silently corrupt a cost figure, and the arithmetic
// should fail safe.
func delta(prev, cur *usage) (usage, bool) {
	if cur == nil {
		return usage{}, false
	}
	if prev == nil || cur.TotalTokens < prev.TotalTokens {
		return *cur, cur.TotalTokens > 0
	}
	if cur.TotalTokens == prev.TotalTokens {
		return usage{}, false
	}
	return usage{
		InputTokens:          nonNeg(cur.InputTokens - prev.InputTokens),
		CachedInputTokens:    nonNeg(cur.CachedInputTokens - prev.CachedInputTokens),
		CacheWriteInputTok:   nonNeg(cur.CacheWriteInputTok - prev.CacheWriteInputTok),
		OutputTokens:         nonNeg(cur.OutputTokens - prev.OutputTokens),
		ReasoningOutputToken: nonNeg(cur.ReasoningOutputToken - prev.ReasoningOutputToken),
		TotalTokens:          cur.TotalTokens - prev.TotalTokens,
	}, true
}

func nonNeg(n int64) int64 {
	if n < 0 {
		return 0
	}
	return n
}

// keyFor builds the per-event idempotency key from the record's position in
// the file.
//
// The line index, not the `ordinal` field. Ordinal looked like the right
// answer and is present in **1 of 100** real transcripts — every older file
// omits it, so it decoded to 0 for every record and every turn in a session
// collapsed onto the single key `codex:turn:0`. One session lost 54 of its 55
// turns that way, and with them their tokens: the store rejects a duplicate
// key, which is exactly the behaviour that makes re-reading safe and exactly
// what made this silent.
//
// A line index is unique by construction in an append-only file, and stable
// for the same reason ordinal would have been: earlier lines never move.
func keyFor(line int64, kind string) string {
	return "codex:" + kind + ":" + itoa(line)
}

func itoa(n int64) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b [24]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}

func parseTime(s string) time.Time {
	if s == "" {
		return time.Time{}
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339} {
		if t, err := time.Parse(layout, s); err == nil {
			return t
		}
	}
	return time.Time{}
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

// Transcript is a rollout file on disk, before it is parsed.
type Transcript struct {
	Path     string
	Modified time.Time
	Size     int64
}

// List finds every rollout transcript under dir, newest first.
//
// It walks rather than globbing a fixed depth: the layout is YYYY/MM/DD today,
// and a walk keeps working if Codex changes it. Directories it cannot read are
// skipped rather than failing the scan — a transcript root is someone else's
// directory and may contain anything.
func List(dir string) ([]Transcript, error) {
	if dir == "" {
		return nil, nil
	}
	var out []Transcript
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			if d != nil && d.IsDir() {
				return fs.SkipDir
			}
			return nil // unreadable entry: skip it, keep scanning
		}
		if d.IsDir() || !strings.HasSuffix(path, ".jsonl") {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			// The file went away between the walk listing it and this stat —
			// Codex rotates and deletes its own transcripts. Dropping the entry
			// is right; failing the whole scan for it would lose every other
			// transcript on the machine. Deliberately swallowed, hence the lint
			// exemption rather than a bare `return nil`.
			return nil //nolint:nilerr // a vanished file is not a scan failure
		}
		out = append(out, Transcript{Path: path, Modified: info.ModTime(), Size: info.Size()})
		return nil
	})
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, err
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Modified.After(out[j].Modified) })
	return out, nil
}

// Available reports whether Codex transcripts exist on this machine.
func Available() bool {
	d := Dir()
	if d == "" {
		return false
	}
	st, err := os.Stat(d)
	return err == nil && st.IsDir()
}
