// Package shim is the hook shim logic shared by the caprock-hook binary and the
// hidden `caprock hook` fallback command. It reads a hook payload from stdin,
// POSTs it to the local daemon, and never fails: every error path is silent and
// the caller exits 0. See .ai/03-contracts.md § Hook shim.
package shim

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"time"

	"github.com/dspv/caprock/internal/config"
)

const (
	maxStdin      = 4 << 20
	fireAndForget = 900 * time.Millisecond // total budget for non-Stop events (< 1s)
	stopBudget    = 5 * time.Second        // Stop request-response budget
	// DebugEnv, when set, appends diagnostics to <data_dir>/hook-debug.log.
	DebugEnv = "CAPROCK_HOOK_DEBUG"
)

// Run executes one shim invocation. It returns nothing: callers always exit 0.
func Run(stdin io.Reader, stdout io.Writer) {
	defer func() {
		if r := recover(); r != nil {
			debugf("panic: %v", r)
		}
	}()
	body, err := io.ReadAll(io.LimitReader(stdin, maxStdin))
	if err != nil || len(body) == 0 {
		debugf("stdin: %v (len=%d)", err, len(body))
		return
	}
	dir, err := config.DataDir()
	if err != nil {
		debugf("data dir: %v", err)
		return
	}
	rt, err := config.ReadRuntime(dir)
	if err != nil {
		debugf("runtime.json: %v", err) // daemon not running: drop silently
		return
	}
	isStop := hookEventName(body) == "Stop"
	budget := fireAndForget
	if isStop {
		budget = stopBudget
	}
	ctx, cancel := context.WithTimeout(context.Background(), budget)
	defer cancel()

	url := fmt.Sprintf("http://127.0.0.1:%d/v1/hook", rt.Port)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		debugf("request: %v", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+rt.Token)
	client := &http.Client{
		Transport: &http.Transport{
			DialContext:           (&net.Dialer{Timeout: 300 * time.Millisecond}).DialContext,
			DisableKeepAlives:     true,
			ResponseHeaderTimeout: budget,
		},
	}
	resp, err := client.Do(req)
	if err != nil {
		debugf("post: %v", err)
		return
	}
	defer resp.Body.Close()
	if !isStop || resp.StatusCode != http.StatusOK {
		return
	}
	reply, err := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if err != nil || len(bytes.TrimSpace(reply)) == 0 || !json.Valid(reply) {
		return
	}
	// The only stdout the shim ever produces: a hook decision for Claude Code.
	_, _ = stdout.Write(reply)
}

func hookEventName(body []byte) string {
	var p struct {
		Name string `json:"hook_event_name"`
	}
	_ = json.Unmarshal(body, &p)
	return p.Name
}

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
	fmt.Fprintf(f, "%s "+format+"\n", append([]any{time.Now().Format(time.RFC3339)}, args...)...)
}
