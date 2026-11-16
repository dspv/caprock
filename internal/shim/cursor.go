package shim

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/dspv/caprock/internal/config"
)

// CursorArg is the argument that makes the shim answer Cursor rather than
// Claude Code: hooks.json registers `"<shim>" cursor` (ADR-095).
const CursorArg = "cursor"

// cursorSessionEnv names the Caprock session a Cursor CLI Caprock started
// belongs to; cursor.EnvSession, repeated so the shim does not link the
// cursor package and its database driver.
const cursorSessionEnv = "CAPROCK_CURSOR_SESSION"

// cursorReply is the neutral answer for one Cursor hook (cursor.NeutralReply):
// beforeSubmitPrompt takes {"continue":true}; every hook Caprock registers
// besides takes {} as "nothing to add". Caprock registers no permission hook,
// where the answer would be a decision.
func cursorReply(event string) string {
	if event == "beforeSubmitPrompt" {
		return `{"continue":true}`
	}
	return `{}`
}

// RunCursor is one Cursor hook invocation. Its first act is to print the
// neutral reply, so Cursor has its answer whatever happens next; then it
// forwards the payload to the daemon within the same budget as a Claude
// Code hook, and every failure is silent (rule 3).
func RunCursor(stdin io.Reader, stdout io.Writer) {
	defer func() {
		if r := recover(); r != nil {
			debugf("cursor panic: %v", r)
		}
	}()
	body, err := io.ReadAll(io.LimitReader(stdin, maxStdin))
	name := ""
	if err == nil && len(body) > 0 {
		name = hookEventName(body)
	}
	_, _ = fmt.Fprintln(stdout, cursorReply(name))
	if err != nil || len(body) == 0 {
		return
	}
	dir, err := config.DataDir()
	if err != nil {
		return
	}
	rt, err := config.ReadRuntime(dir)
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), fireAndForget)
	defer cancel()
	url := fmt.Sprintf("http://127.0.0.1:%d/v1/hook/cursor", rt.Port)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+rt.Token)
	req.Header.Set("X-Caprock-Ppid", strconv.Itoa(os.Getppid()))
	if s := os.Getenv(cursorSessionEnv); s != "" {
		req.Header.Set("X-Caprock-Session", s)
	}
	client := &http.Client{Transport: &http.Transport{
		DialContext:           (&net.Dialer{Timeout: 300 * time.Millisecond}).DialContext,
		DisableKeepAlives:     true,
		ResponseHeaderTimeout: fireAndForget,
	}}
	resp, err := client.Do(req)
	if err != nil {
		debugf("cursor post: %v", err)
		return
	}
	_ = resp.Body.Close()
}
