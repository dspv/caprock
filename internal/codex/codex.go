// Package codex reads OpenAI Codex's session transcripts.
//
// Codex is the easiest of the three agents to observe. It writes one JSONL
// "rollout" file per session under $CODEX_HOME/sessions/YYYY/MM/DD/ (moved to
// $CODEX_HOME/archived_sessions/ when the thread is archived), and that file
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

	"github.com/klauspost/compress/zstd"

	"github.com/dspv/caprock/internal/ingest"
)

// maxLine bounds one JSONL record. Codex embeds whole file contents in tool
// output, so a rollout line is occasionally very large; this is generous enough
// for real transcripts and still refuses a runaway.
const maxLine = 8 << 20

// Home is Codex's state directory: `$CODEX_HOME` when it is set, otherwise
// `~/.codex`. Codex documents CODEX_HOME as the override for everything it
// keeps locally, transcripts included, so a user who set it has no
// `~/.codex/sessions` for us to find — reading only the default path missed
// every one of their sessions.
//
// It is the same path on every platform: Codex uses the home directory
// directly, with no XDG or %APPDATA% branching, so there is nothing to switch
// on here.
func Home() string {
	if d := strings.TrimSpace(os.Getenv(EnvHome)); d != "" {
		return d
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".codex")
}

// EnvHome is Codex's own override of its state directory.
const EnvHome = "CODEX_HOME"

// Dirs are the roots Codex writes rollout transcripts under: `sessions/`
// (YYYY/MM/DD/rollout-*.jsonl) and `archived_sessions/`, where archiving a
// thread moves its rollout — a rename into one flat directory, the file
// itself unchanged (codex-rs thread-store, archive_thread.rs). An archived
// session is still work that was done and paid for; reading only `sessions/`
// never counted one archived before Caprock was installed, and lost it from
// any total rebuilt from the transcripts afterwards.
//
// CAPROCK_CODEX_DIR overrides both with a single root, for tests and for
// anyone whose transcripts live somewhere unusual.
func Dirs() []string {
	if d := strings.TrimSpace(os.Getenv(EnvDir)); d != "" {
		return []string{d}
	}
	home := Home()
	if home == "" {
		return nil
	}
	return []string{filepath.Join(home, "sessions"), filepath.Join(home, "archived_sessions")}
}

// EnvDir overrides the transcript roots with one directory.
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
	// Prompts are what the person typed (§ Chat in .ai/19-codex.md). Empty for
	// imported and subagent threads: the first replays another agent's
	// session, the second its parent's history and a brief its parent wrote.
	Prompts []Prompt
	// Results are what each tool call handed back, paired to its call by
	// CallID.
	Results []ToolResult
	// Limits is the most recent plan-limit sample in the transcript, when the
	// session carried one.
	Limits *Limits
	// Imported marks a thread Codex built by importing another agent's
	// session (its "import from Claude Code"): every turn id is
	// `external-import-turn-N` and the replay ends on an
	// `<EXTERNAL SESSION IMPORTED>` message. Its assistant messages are that
	// other agent's prose and tool calls replayed as text, which Caprock
	// already holds from the original transcript, so none is kept as Codex's.
	Imported bool
	// Subagent marks a thread Codex spawned for a sub-task or for its guardian
	// reviewer (`session_meta.source.subagent`). Such a file opens with a copy
	// of its parent's history and carries the parent's session id, so ID is
	// the parent's and ThreadID the subagent's own.
	Subagent bool
	// TurnDoneAt is when the newest request Codex finished ended — its
	// `task_complete` — while no request runs after it; zero while one
	// runs, after a `turn_aborted`, and before any finished. It is Codex's
	// "the turn ended", read for end_when_done (Ingester.OnTurnDone).
	TurnDoneAt time.Time
	// ThreadID is this file's own thread id (`session_meta.id` of its first
	// record). For a session a person started it equals ID; for a subagent it
	// names the subagent, and its event keys carry it (see subagentKey).
	ThreadID string
}

// Turn is one assistant turn's token usage, already reduced to a delta.
type Turn struct {
	At time.Time
	// Key is stable across re-reads: the transcript is append-only, so the
	// line of the record that produced the turn identifies it forever.
	Key string
	// Line is that record's line number, kept so the key an earlier version
	// gave a subagent's turn can be rebuilt (LegacyKey).
	Line       int64
	In         int64
	CacheRead  int64
	CacheWrite int64
	Out        int64
	// Reasoning tokens are billed as output and are already included in Out.
	// Carried separately only so a reader can see the split.
	Reasoning int64
	// TotalOnly marks a turn whose transcript reported a total with no
	// breakdown, so `In` holds that total rather than a measured input figure.
	// Its cost is therefore an upper bound: any part of it that was really a
	// cached read would have been billed at a tenth.
	TotalOnly bool
	// Text is the prose the assistant wrote in this turn — the `output_text`
	// of the assistant messages the sampling request produced — clipped like
	// Claude Code's (ingest.ClipAssistantText). Empty for a turn that only
	// called tools, and for imported and subagent threads (see Session).
	Text string
}

// ToolCall is one tool invocation.
type ToolCall struct {
	At   time.Time
	Key  string
	Line int64
	Name string
	// Input is the raw argument payload, stored so the dashboard can show what
	// a call actually did.
	Input string
	// TurnKey is the Key of the turn that paid for this call: the first turn
	// recorded after it. Codex writes a response's items (reasoning, message,
	// function calls) first and the token_count that bills that response
	// after them, so the call's turn is the next one in the file. Empty when
	// no turn followed, as at the end of an aborted response.
	TurnKey string
	// CallID is Codex's own id for the call, which its output record repeats.
	// Stored as the call's `tool_use_id`, the key Claude Code pairs a call
	// with its result by.
	CallID string
}

// Prompt is one message the person typed.
type Prompt struct {
	At   time.Time
	Key  string
	Line int64
	// Text is the message's text parts joined with a newline, clipped like
	// Claude Code's prose. An attached image adds nothing.
	Text string
}

// ToolResult is what one tool call handed back: a `custom_tool_call_output`
// or `function_call_output` record.
type ToolResult struct {
	At     time.Time
	Key    string
	Line   int64
	CallID string
	// Name is the call's tool, from the call record with the same CallID; ""
	// when the call is not in the file.
	Name string
	// Output is the text handed back, clipped to MaxToolOutput runes.
	Output string
	// Failed is set when the output says so: an `exec` script that failed, a
	// shell command with a non-zero exit code, or a call Codex refused.
	Failed bool
	// ExitCode is the shell's exit code where Codex recorded one (the
	// `shell` tool's metadata); nil elsewhere — an `exec` script reports only
	// whether the script itself completed.
	ExitCode *int
	// Interrupted marks a call whose request ended — Codex wrote
	// `turn_aborted` or `task_complete`, or the next request started — with
	// no output record for it. Nothing ran on after that point, so the call
	// is over, not running; Output is empty. Line is the call's own line, so
	// the key is fixed however many times the file is read.
	Interrupted bool
}

// MaxToolOutput caps the tool output kept per call, in runes. Codex's outputs
// are long — `exec` asks for up to 15,000 tokens — and every one is stored, so
// the cap bounds the database rather than the screen. Measured on the owner's
// 16,152 outputs (2026-10-09): 107MB of JSON at a 32KiB cap, 47MB at 8KiB.
const MaxToolOutput = 8000

// Limits is the plan-limit sample a transcript last recorded.
//
// The windows are a list, not a fixed primary/secondary pair, because which
// window sits in which slot depends on the plan. Measured on the 72 of 176
// transcripts that carry limits on the owner's machine: a `plus` account
// writes `primary` = 300 minutes and `secondary` = 10080; a `prolite` account
// writes `primary` = 10080 and `secondary` = null — it has no five-hour window
// at all. Reading `primary` as "the 5-hour window" would have put a weekly
// figure under a five-hour label.
type Limits struct {
	// At is when Codex wrote the sample, not when Caprock read it — which can
	// be days later for a transcript imported on first run.
	At      time.Time
	Windows []LimitWindow
}

// LimitWindow is one window as Codex reports it.
type LimitWindow struct {
	Minutes     int
	UsedPercent float64
	// ResetsAt is unix seconds; 0 where Codex wrote null (CLI 0.4x did).
	ResetsAt int64
}

// codexLimitID is the `limit_id` of the plan's own usage limit. Codex also
// writes samples for other limits (`premium`, with no windows, was seen), and
// before limit_id existed the field was absent, which decodes as "".
const codexLimitID = "codex"

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
	// BaseInstructions carries the model the session's system prompt was built
	// for, which is the only place most transcripts name a model at all.
	//
	// Deliberately json.RawMessage rather than a typed struct: this field is
	// not ours, and it has already been seen as an object here. Typed, a
	// version of Codex that writes it as a plain string makes the *whole*
	// session_meta fail to decode — and with it the session id, so the entire
	// transcript is discarded as "not a rollout file". One unexpected field
	// type must cost the model, not the session.
	BaseInstructions json.RawMessage `json:"base_instructions"`
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
		LimitID   string  `json:"limit_id"`
		Primary   *window `json:"primary"`
		Secondary *window `json:"secondary"`
	} `json:"rate_limits"`
}

type window struct {
	UsedPercent   float64 `json:"used_percent"`
	WindowMinutes int     `json:"window_minutes"`
	ResetsAt      *int64  `json:"resets_at"`
}

// message is a `response_item` of type "message". Only the assistant's are
// read; `content` is a list of typed blocks, of which `output_text` is the
// prose. Reasoning is a separate `reasoning` item and is never read here.
type message struct {
	Role    string `json:"role"`
	Content []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content"`
}

// eventKind is the part of an `event_msg` payload the parser branches on:
// token_count, the bracket Codex writes around one user request —
// task_started, then task_complete or turn_aborted — and the two records of
// what the person typed (userItem, `user_message`).
type eventKind struct {
	Type   string `json:"type"`
	TurnID string `json:"turn_id"`
	// Message is a `user_message` event's text and Item an `item_completed`
	// event's item, both decoded only for those two kinds: typed here, a
	// field of another shape on any other kind would fail the whole record.
	Message json.RawMessage `json:"message"`
	Item    json.RawMessage `json:"item"`
}

// userItem is the part of an `item_completed` item read here: a `UserMessage`
// item is exactly what the person typed. The `response_item` message with role
// `user` is not read, because Codex writes its own context the same way — the
// environment block, AGENTS.md, plugin hints — and only metadata that newer
// versions add tells the two apart.
type userItem struct {
	Type    string `json:"type"`
	Content []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content"`
}

// toolOutputPayload is a `custom_tool_call_output` or `function_call_output`.
// Output is a string or a list of typed text blocks, by version and tool.
type toolOutputPayload struct {
	CallID string          `json:"call_id"`
	Output json.RawMessage `json:"output"`
}

// importedTurnPrefix is the turn id Codex gives every turn of a session it
// imported from another agent, and importedMarker the message that ends the
// replay. Measured on the owner's machine on 2026-10-01: all 100 threads
// listed in ~/.codex/external_agent_session_imports.json carry the prefix, and
// none of the other 76 rollouts does.
const (
	importedTurnPrefix = "external-import-turn-"
	importedMarker     = "<EXTERNAL SESSION IMPORTED>"
)

type toolCallPayload struct {
	Name   string          `json:"name"`
	CallID string          `json:"call_id"`
	Input  json.RawMessage `json:"input"`
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
	s, _, err := parseFile(path)
	return s, err
}

// parseFile is ParseFile, also saying how much it read.
func parseFile(path string) (*Session, readCounts, error) {
	var rc readCounts
	f, err := os.Open(path)
	if err != nil {
		return nil, rc, err
	}
	defer f.Close()
	cr := &countingReader{r: f}
	var s *Session
	if !strings.HasSuffix(path, compressedSuffix) {
		s, rc.records, err = parse(cr, path)
	} else {
		dec, derr := zstd.NewReader(cr)
		if derr != nil {
			return nil, rc, derr
		}
		defer dec.Close()
		s, rc.records, err = parse(dec, path)
	}
	rc.bytes = cr.n
	return s, rc, err
}

// countingReader counts the bytes read through it.
type countingReader struct {
	r io.Reader
	n int64
}

func (c *countingReader) Read(b []byte) (int, error) {
	n, err := c.r.Read(b)
	c.n += int64(n)
	return n, err
}

// compressedSuffix is what Codex gives a rollout it has compressed. Codex
// compresses every local rollout untouched for seven days into
// `<name>.jsonl.zst` and deletes the plain file (codex-rs/rollout/src/
// compression.rs, read 2026-10-03), so a reader that lists only `.jsonl` sees
// a week of history and no more: nothing older survives a fresh install or a
// rebuilt database, and nothing is reported missing.
const compressedSuffix = ".jsonl.zst"

// isRollout reports whether path names a rollout transcript, plain or
// compressed.
func isRollout(path string) bool {
	return strings.HasSuffix(path, ".jsonl") || strings.HasSuffix(path, compressedSuffix)
}

// rolloutName is a rollout's file name without its extension, the same for
// the plain file and its compressed form.
func rolloutName(path string) string {
	base := filepath.Base(path)
	return strings.TrimSuffix(strings.TrimSuffix(base, ".zst"), ".jsonl")
}

// Parse reads a rollout transcript from r. path is used only for the returned
// Session's Path field.
//
// The record-by-record work lives in parser (parser.go), which a growing file
// keeps between reads (tail.go); Parse is that parser run once over the whole
// file, and is the reference every incremental read is tested against.
func Parse(r io.Reader, path string) (*Session, error) {
	s, _, err := parse(r, path)
	return s, err
}

// parse is Parse, also returning how many records it decoded.
func parse(r io.Reader, path string) (*Session, int64, error) {
	p := newParser(path)
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64<<10), maxLine)
	for sc.Scan() {
		p.feed(sc.Bytes())
	}
	if err := sc.Err(); err != nil && !errors.Is(err, bufio.ErrTooLong) {
		// ErrTooLong is survivable: one oversized line is dropped, and the rest
		// of the transcript is still worth having.
		return nil, p.decoded, err
	}
	s := p.header()
	if s.ID == "" {
		// No session_meta means this is not a rollout file we understand.
		return nil, p.decoded, ErrNotASession
	}
	p.fill(s, marks{})
	return s, p.decoded, nil
}

// readOutput reads a tool call's output: its text, and whether it failed.
//
// Three shapes, all measured on the owner's machine (2026-10-09, 16,152
// outputs): a list of `input_text` blocks (`exec` — "Script completed" or
// "Script failed" first — and `js`), a plain string (most function tools), and
// a string holding a JSON object `{"output", "metadata": {"exit_code"}}` (the
// `shell` tool, the only one that records an exit code).
func readOutput(raw json.RawMessage) ToolResult {
	var r ToolResult
	var text string
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	switch {
	case json.Unmarshal(raw, &text) == nil:
	case json.Unmarshal(raw, &blocks) == nil:
		var b strings.Builder
		for _, x := range blocks {
			if x.Type != "input_text" && x.Type != "output_text" && x.Type != "text" {
				continue // an image the tool handed back
			}
			if b.Len() > 0 && !strings.HasSuffix(b.String(), "\n") {
				b.WriteByte('\n')
			}
			b.WriteString(x.Text)
		}
		text = b.String()
	default:
		text = string(raw)
	}
	if strings.HasPrefix(text, "{") {
		var sh struct {
			Output   *string `json:"output"`
			Metadata *struct {
				ExitCode *int `json:"exit_code"`
			} `json:"metadata"`
		}
		if json.Unmarshal([]byte(text), &sh) == nil && sh.Output != nil {
			text = *sh.Output
			if sh.Metadata != nil && sh.Metadata.ExitCode != nil {
				code := *sh.Metadata.ExitCode
				r.ExitCode = &code
			}
		}
	}
	r.Failed = strings.HasPrefix(text, "Script failed") || strings.HasPrefix(text, "failed ") ||
		(r.ExitCode != nil && *r.ExitCode != 0)
	r.Output = clipOutput(text)
	return r
}

// clipOutput cuts a tool's output to MaxToolOutput runes on a rune boundary.
func clipOutput(s string) string {
	n := 0
	for i := range s {
		if n == MaxToolOutput {
			return s[:i] + "…[truncated]"
		}
		n++
	}
	return s
}

// joinText joins a turn's messages the way Claude Code's text blocks are
// joined, and clips the result with the same rune-safe cap.
func joinText(parts []string) string {
	keep := parts[:0:0]
	for _, p := range parts {
		if p != "" {
			keep = append(keep, p)
		}
	}
	if len(keep) == 0 {
		return ""
	}
	return ingest.ClipAssistantText(strings.Join(keep, "\n"))
}

// isSubagentSource reports whether session_meta.source names a subagent. It is
// a plain string ("cli", "vscode") for a session a person started and an
// object with a `subagent` key for one Codex spawned.
func isSubagentSource(raw json.RawMessage) bool {
	var src map[string]json.RawMessage
	if json.Unmarshal(raw, &src) != nil {
		return false
	}
	_, ok := src["subagent"]
	return ok
}

// jsonString decodes a raw value as a string, or returns "" for anything else.
// Absent, null, a number, an object — all mean "not a string we can use", none
// of them an error worth losing a session over.
func jsonString(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return ""
	}
	return s
}

// provenanceModel reads the model id out of base_instructions, tolerating any
// shape it is not. Only a provenance of type "model" names a model; anything
// else describes the instructions some other way and is not one.
func provenanceModel(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var bi struct {
		Provenance *struct {
			Type  string `json:"type"`
			Model string `json:"model"`
		} `json:"provenance"`
	}
	if err := json.Unmarshal(raw, &bi); err != nil {
		return "" // a string, a number, anything: no model here, and no error
	}
	if bi.Provenance == nil || bi.Provenance.Type != "model" {
		return ""
	}
	return bi.Provenance.Model
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

// subagentKey keys a subagent's record by its own thread id and line, so it
// can never name a row its parent's file wrote under the shared session id.
// Only subagent files use it: changing the key of any file already imported
// would store every one of its events a second time.
func subagentKey(thread string, line int64, kind string) string {
	return "codex:sub:" + thread + ":" + kind + ":" + itoa(line)
}

// LegacyKey is the key versions before subagentKey gave the record on this
// line — the one a subagent's rows were stored under inside its parent's
// session, and the one the repair finds them by.
func LegacyKey(line int64, kind string) string { return keyFor(line, kind) }

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
		if d.IsDir() || !isRollout(path) {
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

// ListAll lists the transcripts under every root, newest first. A root that
// does not exist contributes nothing: most machines have never archived a
// Codex thread, so `archived_sessions/` is usually absent.
func ListAll(dirs []string) ([]Transcript, error) {
	var out []Transcript
	for _, d := range dirs {
		ts, err := List(d)
		if err != nil {
			return nil, err
		}
		out = append(out, ts...)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Modified.After(out[j].Modified) })
	return out, nil
}

// Available reports whether Codex transcripts exist on this machine.
func Available() bool {
	for _, d := range Dirs() {
		if st, err := os.Stat(d); err == nil && st.IsDir() {
			return true
		}
	}
	return false
}
