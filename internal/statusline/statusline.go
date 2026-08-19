// Package statusline is the `caprock statusline` command's logic: Claude Code
// invokes it (statusLine.command in settings.json) on every assistant message,
// piping a JSON status object on stdin. It prints a compact one-line status to
// stdout and, best-effort, forwards the rate-limit windows to the local daemon so
// the Cost screen can show them. It never fails: the status line is printed
// before any network call, and every error path is silent with exit 0.
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
	"os"
	"strings"
	"time"

	"github.com/dspv/caprock/internal/config"
)

const (
	maxStdin = 256 << 10 // the statusline JSON is tiny; generous cap
	// The daemon POST is pure bonus (the line is already printed), so a short leash.
	dialTimeout = 200 * time.Millisecond
	postBudget  = 300 * time.Millisecond
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

// Run executes one statusline invocation. It always returns (callers exit 0).
func Run(stdin io.Reader, stdout io.Writer) {
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
	// 1) Print the status line first — this is the only thing Claude Code waits on.
	_, _ = io.WriteString(stdout, render(in))
	// 2) Best-effort forward the rate limits to the daemon. Skip entirely when
	//    there are none (non-Pro/Max) so those users incur no network cost.
	if in.RateLimits == nil || (in.RateLimits.FiveHour == nil && in.RateLimits.SevenDay == nil) {
		return
	}
	post(forward{SessionID: in.SessionID, FiveHour: in.RateLimits.FiveHour, SevenDay: in.RateLimits.SevenDay})
}

// render builds the one-line status. Segments are included only when present, so
// there is no "$0.00 / ctx 0%" noise before the first response.
func render(in input) string {
	var seg []string
	if in.Model != nil && in.Model.DisplayName != "" {
		seg = append(seg, in.Model.DisplayName)
	}
	if in.ContextWindow != nil {
		seg = append(seg, fmt.Sprintf("ctx %.0f%%", in.ContextWindow.UsedPercentage))
	}
	if in.Cost != nil && in.Cost.TotalCostUSD > 0 {
		seg = append(seg, fmt.Sprintf("$%.3f", in.Cost.TotalCostUSD))
	}
	if in.RateLimits != nil {
		if w := in.RateLimits.FiveHour; w != nil {
			s := colorPct("5h", w.UsedPercentage)
			if r := resetIn(w.ResetsAt); r != "" {
				s += " " + r // avoid a trailing space when resets_at is absent
			}
			seg = append(seg, s)
		}
		if w := in.RateLimits.SevenDay; w != nil {
			seg = append(seg, colorPct("7d", w.UsedPercentage))
		}
	}
	return strings.Join(seg, " · ")
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
