// Package statusline is the `caprock statusline` command's logic: Claude Code
// invokes it (statusLine.command in settings.json) on every assistant message,
// piping a JSON status object on stdin. It prints a compact one-line status to
// stdout and, best-effort, forwards the rate-limit windows to the local daemon so
// the Cost screen can show them. It never fails: the status line is printed
// before any network call, and every error path is silent with exit 0.
//
// In rich mode (`caprock statusline --rich`) it also asks the daemon for the
// session's own counters — turns, tool calls, cache hit rate, token totals —
// which only the daemon knows. That read happens *before* printing, so it is
// the one place the "never wait on the daemon" rule needs defending rather
// than merely obeying: the read carries a hard budget and any failure, timeout
// or missing daemon falls through to exactly the line plain mode prints.
// See .ai/03-contracts.md § Statusline.
package statusline

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	urlpkg "net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/cost"
)

const (
	maxStdin = 256 << 10 // the statusline JSON is tiny; generous cap
	// The daemon POST is pure bonus (the line is already printed), so a short leash.
	dialTimeout = 200 * time.Millisecond
	postBudget  = 300 * time.Millisecond
	// statsBudget bounds the rich-mode read, which the user *is* waiting on.
	// Claude Code debounces the status line at 300ms; staying under that keeps
	// a slow daemon from being felt as a slow prompt.
	statsBudget = 150 * time.Millisecond
	// defaultWidth is assumed when the terminal does not say how wide it is.
	// Chosen as the classic 80 columns: guessing narrow drops a segment that
	// would have fitted, guessing wide wraps the line, and a wrapped status
	// line costs a row of the user's screen every message.
	defaultWidth = 80
	// DebugEnv, when set, appends diagnostics to <data_dir>/hook-debug.log.
	DebugEnv = "CAPROCK_HOOK_DEBUG"
)

// input is the subset of Claude Code's statusline JSON we read. Every field is a
// pointer or omitempty so absence (non-Pro/Max, pre-first-response) is safe.
type input struct {
	SessionID string `json:"session_id"`
	Model     *struct {
		DisplayName string `json:"display_name"`
	} `json:"model"`
	Cost *struct {
		TotalCostUSD float64 `json:"total_cost_usd"`
	} `json:"cost"`
	ContextWindow *struct {
		UsedPercentage float64 `json:"used_percentage"`
	} `json:"context_window"`
	RateLimits *struct {
		FiveHour *window `json:"five_hour"`
		SevenDay *window `json:"seven_day"`
	} `json:"rate_limits"`
}

type window struct {
	UsedPercentage float64 `json:"used_percentage"`
	ResetsAt       int64   `json:"resets_at"`
}

// forward is the whitelisted body POSTed to the daemon — only the rate-limit
// numbers plus the session id, never cwd/repo/branch/transcript from the input.
type forward struct {
	SessionID string  `json:"session_id"`
	FiveHour  *window `json:"five_hour,omitempty"`
	SevenDay  *window `json:"seven_day,omitempty"`
}

// stats is the daemon's answer to GET /v1/statusline/{id} — the session's own
// counters, which the stdin JSON does not carry.
type stats struct {
	Turns      int64 `json:"turns"`
	ToolCalls  int64 `json:"tool_calls"`
	TokensIn   int64 `json:"tokens_in"`
	TokensOut  int64 `json:"tokens_out"`
	CacheRead  int64 `json:"cache_read"`
	CacheWrite int64 `json:"cache_write"`
}

// Options are the knobs the CLI passes in. The zero value is the plain,
// long-standing behaviour, so an existing registration is unaffected.
type Options struct {
	// Rich asks the daemon for the session counters before printing.
	Rich bool
	// Width is the terminal width to fit the line into; 0 means "detect, and
	// fall back to defaultWidth".
	Width int
}

// Run executes one statusline invocation. It always returns (callers exit 0).
func Run(stdin io.Reader, stdout io.Writer) { RunWith(stdin, stdout, Options{}) }

// RunWith is Run with explicit options.
func RunWith(stdin io.Reader, stdout io.Writer, opt Options) {
	defer func() {
		if r := recover(); r != nil {
			debugf("panic: %v", r)
		}
	}()
	body, err := io.ReadAll(io.LimitReader(stdin, maxStdin))
	if err != nil || len(body) == 0 {
		return
	}
	var in input
	if err := json.Unmarshal(body, &in); err != nil {
		debugf("parse: %v", err)
		return
	}
	// 1) In rich mode, fetch the session counters. This is the only step that
	//    happens before printing, and it is bounded so that a slow or absent
	//    daemon costs the user nothing but the extra segments: on any failure
	//    st stays nil and the line is exactly what plain mode prints.
	var st *stats
	if opt.Rich && in.SessionID != "" {
		st = fetchStats(in.SessionID)
	}
	// 2) Print the status line — this is the only thing Claude Code waits on.
	_, _ = io.WriteString(stdout, renderWidth(in, st, opt.Width))
	// 3) Best-effort forward the rate limits to the daemon. Skip entirely when
	//    there are none (non-Pro/Max) so those users incur no network cost.
	if in.RateLimits == nil || (in.RateLimits.FiveHour == nil && in.RateLimits.SevenDay == nil) {
		return
	}
	post(forward{SessionID: in.SessionID, FiveHour: in.RateLimits.FiveHour, SevenDay: in.RateLimits.SevenDay})
}

// segment is one "·"-separated piece of the line. rank orders what survives a
// narrow terminal: the highest rank is dropped first. The ranking is by what a
// user loses least by not seeing — the plan windows are the number that decides
// whether work can continue at all, so they are never dropped.
//
// The counters have three ranks rather than one because dropping them as a
// block is too coarse: the full line is 81 columns on a real session, so a
// single rank meant a standard 80-column terminal lost all four counters to
// save one column. Degrading one at a time keeps turns and steps — the two a
// user actually watches — down to about 47 columns.
type segment struct {
	text string
	rank int
}

const (
	rankEssential = iota // model, context, cost, plan windows
	rankTurns            // turns/steps: the last counters to go
	rankCache            // what the cache cut off the bill
	rankTokens           // input/output totals: the first to go
)

// The mark: the amber ⛰ the favicon draws and the legacy tool led with, with a
// dim wordmark beside it. Two forms, because the wordmark costs ten columns on
// a line that repeats every message — on a standard 80-column terminal that is
// a whole counter's worth. fit() keeps brandFull while it fits and falls back
// to brandMark, so the line is identifiably ours at either width.
const (
	brandMark = "\x1b[33m⛰\x1b[0m"
	brandFull = brandMark + " \x1b[2mcaprock\x1b[0m"
)

// render builds the one-line status at the default width.
func render(in input) string { return renderWidth(in, nil, 0) }

// renderWidth builds the one-line status, dropping the lowest-priority segments
// until it fits. Segments are included only when present, so there is no
// "$0.00 / ctx 0%" noise before the first response.
func renderWidth(in input, st *stats, width int) string {
	var seg []segment
	add := func(rank int, text string) { seg = append(seg, segment{text: text, rank: rank}) }

	// The mark, so the line is identifiably ours rather than an anonymous row
	// of figures. The legacy Python tool led with the same amber ⛰, and the
	// mark survived the pivot — it is what the favicon draws. Amber matches
	// it; the wordmark is dim so the mark identifies without competing with
	// the numbers, which are what the user is actually reading.
	//
	// Ranked essential, not decoration: a badge that disappears exactly when
	// the line gets tight is not a badge. The whole point is that the row of
	// figures is recognisably Caprock's. It shrinks rather than vanishing.
	add(rankEssential, brandFull)

	if in.Model != nil && in.Model.DisplayName != "" {
		add(rankEssential, in.Model.DisplayName)
	}
	if in.ContextWindow != nil {
		add(rankEssential, fmt.Sprintf("ctx %.0f%%", in.ContextWindow.UsedPercentage))
	}
	if in.Cost != nil && in.Cost.TotalCostUSD > 0 {
		add(rankEssential, fmt.Sprintf("$%.3f", in.Cost.TotalCostUSD))
	}
	// The daemon-supplied counters. Each is emitted only once it has something
	// to say: a session with no turns yet shows the plain line rather than a
	// row of zeros claiming nothing has happened.
	if st != nil {
		if st.Turns > 0 {
			s := fmt.Sprintf("%d turns", st.Turns)
			if st.ToolCalls > 0 {
				s += fmt.Sprintf(" · %d steps", st.ToolCalls)
			}
			add(rankTurns, s)
		}
		// What the cache actually bought, not how often it was hit.
		//
		// The hit rate was the obvious figure and it is worthless here: on real
		// sessions the cached reads outnumber uncached input by four orders of
		// magnitude, so every one of this machine's sessions rounds to 100%. A
		// number that is the same for everybody is decoration, and it costs
		// width the useful counters need. The share of the bill the cache cut
		// varies (83–90% across the same sessions) because it weighs reads and
		// writes by what they are actually charged — so it is computed by the
		// same cost.ComputeSavings the Cost screen uses, not a second formula
		// that could drift from it.
		if sv := cost.ComputeSavings(st.TokensIn, st.CacheRead, st.CacheWrite); sv.CutPct > 0 {
			add(rankCache, fmt.Sprintf("cache −%.0f%%", sv.CutPct))
		}
		if st.TokensIn > 0 || st.TokensOut > 0 {
			add(rankTokens, fmt.Sprintf("in %s · out %s", compactTokens(st.TokensIn), compactTokens(st.TokensOut)))
		}
	}
	if in.RateLimits != nil {
		if w := in.RateLimits.FiveHour; w != nil {
			s := colorPct("5h", w.UsedPercentage)
			if r := resetIn(w.ResetsAt); r != "" {
				s += " " + r // avoid a trailing space when resets_at is absent
			}
			add(rankEssential, s)
		}
		if w := in.RateLimits.SevenDay; w != nil {
			add(rankEssential, colorPct("7d", w.UsedPercentage))
		}
	}
	return fit(seg, width)
}

// fit joins the segments, dropping the highest-ranked ones a rank at a time
// until the line fits. Essential segments are never dropped, so a line can
// still exceed the width — that is deliberate: wrapping is a smaller loss than
// a line missing the plan window the user came to read.
func fit(seg []segment, width int) string {
	if width <= 0 {
		width = terminalWidth()
	}
	join := func(in []segment) string {
		parts := make([]string, 0, len(in))
		for _, s := range in {
			parts = append(parts, s.text)
		}
		return strings.Join(parts, " · ")
	}
	// Shrink the badge before dropping anything. The wordmark costs ten
	// columns and carries no information the mark does not — on an 80-column
	// terminal that is the difference between showing turns/steps and showing
	// nothing, so trading it for a real counter is the right way round.
	if displayWidth(join(seg)) > width {
		for i, s := range seg {
			if s.text == brandFull {
				seg[i].text = brandMark
				break
			}
		}
	}
	for rank := rankTokens; rank > rankEssential; rank-- {
		if displayWidth(join(seg)) <= width {
			break
		}
		kept := seg[:0:0] // fresh backing array; seg is reused by the next round
		for _, s := range seg {
			if s.rank < rank {
				kept = append(kept, s)
			}
		}
		seg = kept
	}
	return join(seg)
}

// displayWidth is the printed width of a line: runes, not bytes, and with the
// ANSI colour codes discounted because the terminal does not draw them.
func displayWidth(s string) int {
	n, inEsc := 0, false
	for _, r := range s {
		switch {
		case inEsc:
			// A CSI sequence ends at its final byte, which is what "m" is in
			// the colour codes this file emits.
			if r == 'm' {
				inEsc = false
			}
		case r == '\x1b':
			inEsc = true
		default:
			n++
		}
	}
	return n
}

// compactTokens renders a token count the way the eye reads it: 1.5M, 35.6K, 812.
func compactTokens(n int64) string {
	switch {
	case n >= 1_000_000:
		return fmt.Sprintf("%.1fM", float64(n)/1_000_000)
	case n >= 1_000:
		return fmt.Sprintf("%.1fK", float64(n)/1_000)
	default:
		return fmt.Sprintf("%d", n)
	}
}

// terminalWidth is the width to fit the line into.
//
// Claude Code pipes our stdout rather than handing us the terminal, so asking
// the file descriptor how wide it is answers about a pipe, not about the
// window. COLUMNS is the one signal that survives that, and when it is absent
// or nonsense we assume the conventional 80 rather than guessing wide.
func terminalWidth() int {
	n, err := strconv.Atoi(strings.TrimSpace(os.Getenv("COLUMNS")))
	if err != nil || n < 20 {
		return defaultWidth
	}
	return n
}

// fetchStats asks the daemon for the session counters. Every failure path
// returns nil, which renders the plain line — the daemon being down, slow or
// unreachable must cost the user nothing but the extra segments.
func fetchStats(sessionID string) *stats {
	dir, err := config.DataDir()
	if err != nil {
		return nil
	}
	rt, err := config.ReadRuntime(dir)
	if err != nil {
		debugf("runtime.json: %v", err) // daemon not running
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), statsBudget)
	defer cancel()
	url := fmt.Sprintf("http://127.0.0.1:%d/v1/statusline/%s", rt.Port, urlpkg.PathEscape(sessionID))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil
	}
	req.Header.Set("Authorization", "Bearer "+rt.Token)
	client := &http.Client{Transport: &http.Transport{
		DialContext:       (&net.Dialer{Timeout: dialTimeout}).DialContext,
		DisableKeepAlives: true,
	}}
	resp, err := client.Do(req)
	if err != nil {
		debugf("stats: %v", err)
		return nil
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		debugf("stats: status %d", resp.StatusCode)
		return nil
	}
	var st stats
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<16)).Decode(&st); err != nil {
		debugf("stats decode: %v", err)
		return nil
	}
	return &st
}

// colorPct renders "label NN%" with a threshold color (green/amber/red).
func colorPct(label string, pct float64) string {
	code := "32" // green
	switch {
	case pct > 85:
		code = "31" // red
	case pct >= 60:
		code = "33" // amber
	}
	return fmt.Sprintf("%s \x1b[%sm%.0f%%\x1b[0m", label, code, pct)
}

// resetIn formats "resets HH:MM" from a unix-seconds reset time, in local time.
func resetIn(resetsAt int64) string {
	if resetsAt <= 0 {
		return ""
	}
	return "resets " + time.Unix(resetsAt, 0).Format("15:04")
}

// post fire-and-forgets the rate-limit windows to the daemon. Any failure (daemon
// down, timeout) is dropped silently — the status line was already printed.
func post(f forward) {
	dir, err := config.DataDir()
	if err != nil {
		return
	}
	rt, err := config.ReadRuntime(dir)
	if err != nil {
		debugf("runtime.json: %v", err) // daemon not running
		return
	}
	payload, err := json.Marshal(f)
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), postBudget)
	defer cancel()
	url := fmt.Sprintf("http://127.0.0.1:%d/v1/statusline", rt.Port)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+rt.Token)
	client := &http.Client{Transport: &http.Transport{
		DialContext:       (&net.Dialer{Timeout: dialTimeout}).DialContext,
		DisableKeepAlives: true,
	}}
	resp, err := client.Do(req)
	if err != nil {
		debugf("post: %v", err)
		return
	}
	_ = resp.Body.Close() // response ignored; fire-and-forget
}

// debugf appends a diagnostic line to <data_dir>/hook-debug.log when
// CAPROCK_HOOK_DEBUG is set. Never writes to stdout/stderr (that is the status
// line) and never logs the payload data.
func debugf(format string, args ...any) {
	if os.Getenv(DebugEnv) == "" {
		return
	}
	dir, err := config.DataDir()
	if err != nil {
		return
	}
	f, err := os.OpenFile(config.HookDebugLogPath(dir), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "[statusline] "+format+"\n", args...)
}
