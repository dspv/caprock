// Package loop implements the loop detector: ≥ K tool.pre events with the same
// tool and normalized-similar input within T minutes ⇒ one alert per episode.
// This is the "a session in a loop drains your budget" feature (traceability #1).
package loop

import (
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/toolcmd"
)

// Alert is what the detector emits (WS "alert" frame).
type Alert struct {
	Kind      string    `json:"kind"` // "loop"
	SessionID string    `json:"session_id"`
	Tool      string    `json:"tool"`
	Count     int       `json:"count"`
	WindowMin int       `json:"window_min"`
	Sample    string    `json:"sample"` // human-readable sample of the repeated input
	FirstTs   time.Time `json:"first_ts"`
	LastTs    time.Time `json:"last_ts"`
	Ts        time.Time `json:"ts"`
	// TaxUSD is what the repeated calls paid to re-read the conversation --
	// sum of each call's context at cache-read rates, and nothing else.
	//
	// This is deliberately not "what the loop cost". That number was tried
	// twice and was wrong both times: the session total read as the loop's
	// price, and the spend inside the loop's window is mostly the useful work
	// happening alongside it. The tax is neither. It is one term, attributable
	// to these calls exactly, and it must stay labelled as the tax rather than
	// as the loop's cost (rule 6).
	//
	// Zero means not computed -- an alert whose calls carried no usage.
	TaxUSD float64 `json:"tax_usd,omitempty"`
	// IsolatedUSD is what those same calls would have paid for context inside
	// a subagent. Informational: Caprock never acts on it, because the model
	// took the delegation nudge once in eight tries (spec section 6.4).
	IsolatedUSD float64 `json:"isolated_usd,omitempty"`
	// TaxPricedCalls is how many of the repeated calls the tax above covers,
	// out of Count. A call that arrived on the hook plane carries no message
	// id and so cannot be attached to the turn that paid for it -- 13% of all
	// calls on the owner's archive. When this is below Count the figure is an
	// understatement, and the UI says so rather than presenting it as whole.
	TaxPricedCalls int `json:"tax_priced_calls,omitempty"`
}

// Detector keeps a sliding window of recent tool.pre signatures per thread:
// the session's main thread, and each of its subagents apart.
//
// A subagent's calls arrive under its parent's session id (hooks fire inside
// subagents, and the transcript files a sidechain under its parent), so one
// window per session added a subagent's edits to the parent's: the parent and
// three subagents fixing the same import read as one session repeating
// itself, and the parent was flagged for a loop it was not in. Each thread
// now counts only its own calls (lane); a subagent that really loops still
// raises the alert, on the session it works for.
type Detector struct {
	K      int
	Window time.Duration
	// Cooldown suppresses repeat alerts for the same (session, signature) until
	// the loop stops for this long — one alert per episode, not per event.
	Cooldown time.Duration

	mu       sync.Mutex
	sessions map[string]*sessionWindow // by lane
	swept    time.Time                 // when quiet lanes were last dropped
}

// lane is the window an event counts in: the session for its main thread,
// the session and the subagent for a subagent's call (event.Subagent: an
// agent id, or a sidechain mark without one).
func lane(ev event.Event) string {
	if !ev.Subagent() {
		return ev.SessionID
	}
	id := ev.AgentID
	if id == "" {
		id = "sidechain"
	}
	return ev.SessionID + "\x00" + id
}

type hit struct {
	ts     time.Time
	sig    string
	sample string
}

type sessionWindow struct {
	hits    []hit
	alerted map[string]time.Time // signature → last alert ts
}

// New creates a detector with the spec defaults K=5, T=3 minutes when zero.
func New(k int, window time.Duration) *Detector {
	if k <= 0 {
		k = 5
	}
	if window <= 0 {
		window = 3 * time.Minute
	}
	return &Detector{K: k, Window: window, Cooldown: window, sessions: map[string]*sessionWindow{}}
}

// readOnlyTools repeat legitimately and cost nothing, so a repetition of one is
// not the thing this detector exists to catch.
//
// Measured on 64,733 tool calls of real history: the detector fired 436 times,
// and 236 of those — 54% — were a repeated Read of one file. That is ordinary
// work: re-reading a file after editing it, while searching, while comparing.
// A tool call is billed at $0 (verified: SUM(cost_usd) over every tool.pre is
// zero), so none of those alerts warned about money, and every session that
// produced one finished normally.
//
// The package exists to catch "a session in a loop drains your budget". An
// alert that cannot be about the budget is noise competing with the ones that
// can, and noise in an attention surface teaches people to stop reading it.
var readOnlyTools = map[string]bool{
	"Read":         true,
	"Glob":         true,
	"Grep":         true,
	"ToolSearch":   true,
	"NotebookRead": true,
}

// ReadOnly reports whether the detector ignores a tool, so a replay of stored
// calls (the Week card's longest loop) skips exactly what the live alert skips.
func ReadOnly(tool string) bool { return readOnlyTools[tool] }

// ReadOnlyTools lists them, sorted.
func ReadOnlyTools() []string {
	out := make([]string, 0, len(readOnlyTools))
	for t := range readOnlyTools {
		out = append(out, t)
	}
	sort.Strings(out)
	return out
}

// Observe feeds a stored event. It returns an Alert (non-nil) when a loop is
// detected for the first time in an episode.
func (d *Detector) Observe(ev event.Event) *Alert {
	if ev.Kind != event.KindToolPre || ev.SessionID == "" {
		return nil
	}
	if readOnlyTools[ev.Tool] {
		return nil
	}
	sig, sample := Signature(ev.Tool, ev.Payload)
	if sig == "" {
		return nil
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	key := lane(ev)
	// A lane per subagent is many more lanes than one per session: drop the
	// ones that went quiet, once a window, so a long day does not keep them.
	if ev.Ts.Sub(d.swept) > d.Window {
		d.swept = ev.Ts
		for k, w := range d.sessions {
			if n := len(w.hits); n == 0 || ev.Ts.Sub(w.hits[n-1].ts) > d.Window+d.Cooldown {
				delete(d.sessions, k)
			}
		}
	}
	sw := d.sessions[key]
	if sw == nil {
		sw = &sessionWindow{alerted: map[string]time.Time{}}
		d.sessions[key] = sw
	}
	cut := ev.Ts.Add(-d.Window)
	// Drop hits outside the window (hits arrive roughly in order; tolerate skew).
	kept := sw.hits[:0]
	for _, h := range sw.hits {
		if !h.ts.Before(cut) {
			kept = append(kept, h)
		}
	}
	kept = append(kept, hit{ts: ev.Ts, sig: sig, sample: sample})
	sw.hits = kept
	// Also expire alert cooldowns whose loop went quiet.
	for s, t := range sw.alerted {
		if ev.Ts.Sub(t) > d.Cooldown {
			delete(sw.alerted, s)
		}
	}
	count := 0
	first := ev.Ts
	for _, h := range sw.hits {
		if h.sig == sig {
			count++
			if h.ts.Before(first) {
				first = h.ts
			}
		}
	}
	if count < d.K {
		return nil
	}
	if last, ok := sw.alerted[sig]; ok {
		// Still the same episode: refresh the cooldown, no new alert.
		if ev.Ts.Sub(last) <= d.Cooldown {
			sw.alerted[sig] = ev.Ts
			return nil
		}
	}
	sw.alerted[sig] = ev.Ts
	return &Alert{
		Kind: "loop", SessionID: ev.SessionID, Tool: ev.Tool, Count: count,
		WindowMin: int(d.Window / time.Minute), Sample: sample,
		FirstTs: first, LastTs: ev.Ts, Ts: ev.Ts,
	}
}

// Forget drops a session's windows, its subagents' included (session ended).
func (d *Detector) Forget(sessionID string) {
	d.mu.Lock()
	for k := range d.sessions {
		if k == sessionID || strings.HasPrefix(k, sessionID+"\x00") {
			delete(d.sessions, k)
		}
	}
	d.mu.Unlock()
}

// Signature normalizes a tool call into a similarity key: tool name + the
// tool_input with volatile parts (numbers, hashes, temp paths, whitespace)
// collapsed. Two calls that differ only in a retry counter, a line number, or a
// timestamp share a signature — which is exactly what a real loop looks like.
func Signature(tool string, payload json.RawMessage) (sig, sample string) {
	if tool == "" {
		return "", ""
	}
	var p struct {
		ToolInput map[string]json.RawMessage `json:"tool_input"`
	}
	_ = json.Unmarshal(payload, &p)
	return signatureOf(tool, p.ToolInput), Describe(tool, p.ToolInput)
}

// InputSignature is Signature for a call's tool_input alone, without the
// banner text: the same key Signature gives the payload that wraps it. A scan
// over history needs only the key, and reading tool_input out of the payload
// is what keeps the rest of it (a tool's whole response) out of memory.
func InputSignature(tool string, input json.RawMessage) string {
	if tool == "" {
		return ""
	}
	var m map[string]json.RawMessage
	_ = json.Unmarshal(input, &m)
	return signatureOf(tool, m)
}

func signatureOf(tool string, input map[string]json.RawMessage) string {
	// Deterministic field order.
	keys := make([]string, 0, len(input))
	for k := range input {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	b.WriteString(tool)
	b.WriteByte('|')
	for _, k := range keys {
		// Skip fields that never carry intent.
		switch k {
		case "description", "timeout", "run_in_background":
			continue
		}
		var s string
		if err := json.Unmarshal(input[k], &s); err != nil {
			s = string(input[k])
		}
		if k == "content" || k == "new_string" || k == "old_string" {
			// Edit/Write bodies: compare only a fingerprint of the first part; a
			// looping agent rewrites the same file with near-identical content.
			if len(s) > 200 {
				s = s[:200]
			}
		}
		b.WriteString(k)
		b.WriteByte('=')
		b.WriteString(normalize(s))
		b.WriteByte(';')
	}
	sum := sha1.Sum([]byte(b.String()))
	return hex.EncodeToString(sum[:])
}

// normalize collapses the volatile parts of one input field: temp paths, hex
// ids, numbers and runs of whitespace, lower-cased and cut at 400 bytes.
//
// It is one pass over the string and gives exactly what these four
// replacements, in this order, gave (TestNormalizeMatchesRegexps holds it to
// them):
//
//	/tmp/[^\s"']+|/var/folders/[^\s"']+   -> "/tmp/…"
//	\b[0-9a-f]{7,64}\b                     -> "#"
//	\b\d+\b                                -> "0"
//	\s+                                     -> " "
//
// Four regexp passes over every tool call's input were half of what a
// whole-history Week allocated.
func normalize(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	var b strings.Builder
	b.Grow(min(len(s), 512))
	for i := 0; i < len(s) && b.Len() <= 400; {
		c := s[i]
		switch {
		case c == '/':
			if n := tempPathLen(s[i:]); n > 0 {
				b.WriteString("/tmp/…")
				i += n
				continue
			}
			b.WriteByte(c)
			i++
		case isWordByte(c):
			j := i
			hex, digits := true, true
			for j < len(s) && isWordByte(s[j]) {
				d := s[j] >= '0' && s[j] <= '9'
				digits = digits && d
				hex = hex && (d || (s[j] >= 'a' && s[j] <= 'f'))
				j++
			}
			switch n := j - i; {
			case hex && n >= 7 && n <= 64:
				b.WriteByte('#')
			case digits:
				b.WriteByte('0')
			default:
				b.WriteString(s[i:j])
			}
			i = j
		case isSpaceByte(c):
			for i < len(s) && isSpaceByte(s[i]) {
				i++
			}
			b.WriteByte(' ')
		default:
			b.WriteByte(c)
			i++
		}
	}
	out := b.String()
	if len(out) > 400 {
		out = out[:400]
	}
	return out
}

// tempPathLen is the length of the temp path at the start of s, or 0.
func tempPathLen(s string) int {
	for _, prefix := range [...]string{"/tmp/", "/var/folders/"} {
		if !strings.HasPrefix(s, prefix) {
			continue
		}
		n := len(prefix)
		for n < len(s) && !isSpaceByte(s[n]) && s[n] != '"' && s[n] != '\'' {
			n++
		}
		if n > len(prefix) {
			return n
		}
	}
	return 0
}

// isWordByte is regexp's \w: ASCII letters, digits and underscore.
func isWordByte(c byte) bool {
	return c == '_' || (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

// isSpaceByte is regexp's \s: [\t\n\f\r ].
func isSpaceByte(c byte) bool {
	return c == ' ' || c == '\t' || c == '\n' || c == '\f' || c == '\r'
}

// Describe renders a short human-readable form of a tool call for banners.
func Describe(tool string, input map[string]json.RawMessage) string {
	get := func(k string) string {
		var s string
		if v, ok := input[k]; ok && json.Unmarshal(v, &s) == nil {
			return s
		}
		return ""
	}
	var s string
	switch tool {
	case "Bash":
		s = get("command")
	case "exec", "shell", "local_shell", "exec_command":
		// Codex: the line its script or argv ran, not the JavaScript.
		s = toolcmd.Command(tool, get("command"))
	case "Edit", "Write", "MultiEdit", "Read":
		s = get("file_path")
	case "Grep", "Glob":
		s = get("pattern")
	case "WebFetch":
		s = get("url")
	case "WebSearch":
		s = get("query")
	default:
		for _, k := range []string{"command", "file_path", "path", "pattern", "query", "url", "prompt"} {
			if v := get(k); v != "" {
				s = v
				break
			}
		}
	}
	// Sample is rendered in the dashboard, so it must not be cut mid-rune —
	// json silently substitutes U+FFFD rather than erroring.
	s = clipRunes(strings.TrimSpace(s), 120)
	if s == "" {
		return tool
	}
	return tool + ": " + s
}

// clipRunes truncates to at most n runes, never splitting a character.
func clipRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	count := 0
	for i := range s {
		if count == n {
			return s[:i] + "…"
		}
		count++
	}
	return s
}
