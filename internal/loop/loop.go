// Package loop implements the loop detector: ≥ K tool.pre events with the same
// tool and normalized-similar input within T minutes ⇒ one alert per episode.
// This is the "a session in a loop drains your budget" feature (traceability #1).
package loop

import (
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/event"
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
}

// Detector keeps a sliding window of recent tool.pre signatures per session.
type Detector struct {
	K      int
	Window time.Duration
	// Cooldown suppresses repeat alerts for the same (session, signature) until
	// the loop stops for this long — one alert per episode, not per event.
	Cooldown time.Duration

	mu       sync.Mutex
	sessions map[string]*sessionWindow
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

// Observe feeds a stored event. It returns an Alert (non-nil) when a loop is
// detected for the first time in an episode.
func (d *Detector) Observe(ev event.Event) *Alert {
	if ev.Kind != event.KindToolPre || ev.SessionID == "" {
		return nil
	}
	sig, sample := Signature(ev.Tool, ev.Payload)
	if sig == "" {
		return nil
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	sw := d.sessions[ev.SessionID]
	if sw == nil {
		sw = &sessionWindow{alerted: map[string]time.Time{}}
		d.sessions[ev.SessionID] = sw
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

// Forget drops a session's window (session ended).
func (d *Detector) Forget(sessionID string) {
	d.mu.Lock()
	delete(d.sessions, sessionID)
	d.mu.Unlock()
}

var (
	reNums   = regexp.MustCompile(`\b\d+\b`)
	reSpaces = regexp.MustCompile(`\s+`)
	reHex    = regexp.MustCompile(`\b[0-9a-f]{7,64}\b`)
	reTmp    = regexp.MustCompile(`/tmp/[^\s"']+|/var/folders/[^\s"']+`)
)

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
	// Deterministic field order.
	keys := make([]string, 0, len(p.ToolInput))
	for k := range p.ToolInput {
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
		if err := json.Unmarshal(p.ToolInput[k], &s); err != nil {
			s = string(p.ToolInput[k])
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
	raw := b.String()
	sum := sha1.Sum([]byte(raw))
	sample = Describe(tool, p.ToolInput)
	return hex.EncodeToString(sum[:]), sample
}

func normalize(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	s = reTmp.ReplaceAllString(s, "/tmp/…")
	s = reHex.ReplaceAllString(s, "#")
	s = reNums.ReplaceAllString(s, "0")
	s = reSpaces.ReplaceAllString(s, " ")
	if len(s) > 400 {
		s = s[:400]
	}
	return s
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
	s = strings.TrimSpace(s)
	if len(s) > 120 {
		s = s[:120] + "…"
	}
	if s == "" {
		return tool
	}
	return tool + ": " + s
}
