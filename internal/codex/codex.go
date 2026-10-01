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
	// of its parent's history and carries the parent's session id.
	Subagent bool
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
	Name string
	// Input is the raw argument payload, stored so the dashboard can show what
	// a call actually did.
	Input string
}

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
// token_count, and the bracket Codex writes around one user request —
// task_started, then task_complete or turn_aborted.
type eventKind struct {
	Type   string `json:"type"`
	TurnID string `json:"turn_id"`
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
	// pending holds assistant prose not yet tied to a turn. Codex writes a
	// message BEFORE the token_count of the sampling request that produced it,
	// so the text goes onto the next turn. taskStart is where the current user
	// request's turns begin, so a message left over when a request ends joins
	// that request's last turn rather than the next request's first.
	var pending []string
	taskStart := 0
	seenMeta := false
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
			// Decoded field by field rather than into a struct in one go.
			//
			// A single unexpected type anywhere in this payload fails the whole
			// unmarshal, and losing session_meta means losing the session id,
			// which makes the entire transcript "not a rollout file" and drops
			// every turn in it. That is far too much to lose to one field we do
			// not even own — Codex is free to change any of these between
			// releases. Each field is taken if it is the shape we expect and
			// skipped if it is not.
			var m sessionMeta
			raw := map[string]json.RawMessage{}
			if err := json.Unmarshal(rec.Payload, &raw); err != nil {
				continue
			}
			m.SessionID = jsonString(raw["session_id"])
			m.ID = jsonString(raw["id"])
			m.Timestamp = jsonString(raw["timestamp"])
			m.Cwd = jsonString(raw["cwd"])
			m.CLIVersion = jsonString(raw["cli_version"])
			m.Originator = jsonString(raw["originator"])
			m.BaseInstructions = raw["base_instructions"]
			// A forked subagent's file holds its own session_meta and then a
			// copy of its parent's, so only the first one says what this
			// file is.
			if !seenMeta && isSubagentSource(raw["source"]) {
				s.Subagent = true
			}
			seenMeta = true
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
			if model := provenanceModel(m.BaseInstructions); model != "" {
				s.Model = model
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
			var k eventKind
			if err := json.Unmarshal(rec.Payload, &k); err != nil {
				continue
			}
			if strings.HasPrefix(k.TurnID, importedTurnPrefix) {
				s.Imported = true
			}
			switch k.Type {
			case "task_started":
				// Prose from a request that produced no turn at all has no
				// row to sit on and is dropped. Measured: 36 of 2,120
				// messages on the owner's machine, all in subagent files
				// replaying their parent's history.
				pending, taskStart = nil, len(s.Turns)
				continue
			case "task_complete", "turn_aborted":
				if len(pending) > 0 && len(s.Turns) > taskStart {
					last := &s.Turns[len(s.Turns)-1]
					last.Text = joinText(append([]string{last.Text}, pending...))
				}
				pending = nil
				continue
			case "token_count":
			default:
				continue
			}
			var tc tokenCount
			if err := json.Unmarshal(rec.Payload, &tc); err != nil {
				continue
			}
			if rl := tc.RateLimits; rl != nil && (rl.LimitID == "" || rl.LimitID == codexLimitID) && !at.IsZero() {
				l := &Limits{At: at}
				for _, w := range []*window{rl.Primary, rl.Secondary} {
					if w == nil || w.WindowMinutes <= 0 {
						continue
					}
					lw := LimitWindow{Minutes: w.WindowMinutes, UsedPercent: w.UsedPercent}
					if w.ResetsAt != nil {
						lw.ResetsAt = *w.ResetsAt
					}
					l.Windows = append(l.Windows, lw)
				}
				// A sample naming no window says nothing about the plan, and
				// must not replace an earlier one that did.
				if len(l.Windows) > 0 {
					s.Limits = l
				}
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
			turn := Turn{
				At:         at,
				Key:        keyFor(lineNo, "turn"),
				In:         d.InputTokens,
				CacheRead:  d.CachedInputTokens,
				CacheWrite: d.CacheWriteInputTok,
				Out:        d.OutputTokens,
				Reasoning:  d.ReasoningOutputToken,
			}
			// Some transcripts fill in `total_tokens` and leave every component
			// at zero — 114 of 233 samples on the machine this was built
			// against, one of them 4.4M tokens. Reading only the components
			// drops all of that: a real turn stored as if it had used nothing.
			//
			// The total is carried as input, which is the honest reading of a
			// number that says only "this much was used": input is what the
			// billing arithmetic treats as unqualified, so nothing is credited
			// a cache discount it was not reported to have earned. Splitting
			// the total across kinds by any ratio would be inventing the split
			// (rule 6); leaving the turn empty would be discarding the usage.
			if turn.In == 0 && turn.Out == 0 && turn.CacheRead == 0 && turn.CacheWrite == 0 && d.TotalTokens > 0 {
				turn.In = d.TotalTokens
				turn.TotalOnly = true
			}
			turn.Text = joinText(pending)
			pending = nil
			s.Turns = append(s.Turns, turn)
		case "response_item":
			var k payloadKind
			if err := json.Unmarshal(rec.Payload, &k); err != nil {
				continue
			}
			if k.Type == "message" {
				var m message
				if json.Unmarshal(rec.Payload, &m) != nil || m.Role != "assistant" {
					continue
				}
				for _, b := range m.Content {
					if b.Type != "output_text" && b.Type != "text" {
						continue
					}
					t := strings.TrimSpace(b.Text)
					if t == importedMarker {
						s.Imported = true
					}
					if t != "" {
						pending = append(pending, t)
					}
				}
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
	if s.Imported || s.Subagent {
		// Imported prose is another agent's, already stored from its own
		// transcript. A subagent's would be hidden from Memory anyway, as
		// Claude Code's sidechains are — and its file carries the parent's
		// session id, so its rows share keys with the parent's own and a
		// text written from it could land on a parent row.
		for i := range s.Turns {
			s.Turns[i].Text = ""
		}
	}
	return s, nil
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
