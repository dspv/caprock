// The shim runs inside every hook of every Claude Code session on the machine.
// Rule 3 is the whole contract: it never breaks the user's session — every
// error path is a silent return within a second, and the caller exits 0.
//
// That makes the failure paths, not the happy path, the thing worth pinning.
// A daemon that is not running, a port nothing listens on, a server that hangs
// forever, garbage on stdin — each of those is an ordinary Tuesday for the
// shim, and none of them may panic, block, or print anything that Claude Code
// would try to interpret. The smoke suite already covers the happy path end to
// end; these cover what happens when things are wrong.
package shim

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/config"
)

// isolate points the shim at a scratch data dir, so no test can read or write
// the developer's real ~/.../caprock while running.
func isolate(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv(config.EnvDataDir, dir)
	return dir
}

// runtimeFor writes a runtime.json describing a daemon at the given base URL,
// which is what the shim reads to find the port and token.
func runtimeFor(t *testing.T, dir, baseURL string) {
	t.Helper()
	host := strings.TrimPrefix(baseURL, "http://")
	_, portStr, err := net.SplitHostPort(host)
	if err != nil {
		t.Fatalf("split %q: %v", host, err)
	}
	port, err := strconv.Atoi(portStr)
	if err != nil {
		t.Fatalf("port %q: %v", portStr, err)
	}
	if err := config.WriteRuntime(dir, config.Runtime{Port: port, Token: "test-token", PID: 1}); err != nil {
		t.Fatal(err)
	}
}

// runShim calls Run with a deadline. Rule 3 caps every invocation at under a
// second for ordinary events, so a test that hangs is itself a failure — not
// something to wait out.
func runShim(t *testing.T, stdin string, budget time.Duration) string {
	t.Helper()
	var out bytes.Buffer
	done := make(chan struct{})
	go func() {
		defer close(done)
		Run(strings.NewReader(stdin), &out)
	}()
	select {
	case <-done:
		return out.String()
	case <-time.After(budget):
		t.Fatalf("Run did not return within %s — the shim must never block a session", budget)
		return ""
	}
}

func hookBody(t *testing.T, name string) string {
	t.Helper()
	b, err := json.Marshal(map[string]any{
		"hook_event_name": name,
		"session_id":      "s-1",
		"cwd":             "/tmp/x",
	})
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// The common case on a machine where Caprock is installed but not running.
// There is no runtime.json, so there is nothing to POST to — and the user's
// session must not notice.
func TestNoDaemonIsSilent(t *testing.T) {
	isolate(t)
	if out := runShim(t, hookBody(t, "PreToolUse"), 2*time.Second); out != "" {
		t.Errorf("wrote %q to stdout with no daemon running; want nothing", out)
	}
}

// A stale runtime.json outlives the daemon it described — after a crash, or a
// reboot that left the file behind. The port then belongs to nobody.
func TestDeadPortIsSilent(t *testing.T) {
	dir := isolate(t)
	// Bind and immediately release a port, so it is almost certainly free.
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := l.Addr().String()
	if err := l.Close(); err != nil {
		t.Fatal(err)
	}
	runtimeFor(t, dir, "http://"+addr)

	if out := runShim(t, hookBody(t, "PreToolUse"), 2*time.Second); out != "" {
		t.Errorf("wrote %q against a dead port; want nothing", out)
	}
}

// Empty stdin happens when a hook fires with nothing to say, or a pipe closes
// early. There is nothing to send and nothing to report.
func TestEmptyStdinIsSilent(t *testing.T) {
	isolate(t)
	if out := runShim(t, "", time.Second); out != "" {
		t.Errorf("wrote %q on empty stdin; want nothing", out)
	}
}

// Claude Code owns the payload format and may change it. The shim must forward
// whatever it is handed without trying to understand it — malformed JSON is the
// daemon's problem to reject, never a reason to fail the session.
func TestMalformedStdinDoesNotPanic(t *testing.T) {
	dir := isolate(t)
	var got [][]byte
	var mu sync.Mutex
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		mu.Lock()
		got = append(got, b)
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	runtimeFor(t, dir, srv.URL)

	for _, body := range []string{
		"not json at all",
		"{",
		`{"hook_event_name": 42}`,
		`[]`,
		"\x00\xff\xfe binary",
	} {
		if out := runShim(t, body, 2*time.Second); out != "" {
			t.Errorf("body %q produced stdout %q; want nothing", body, out)
		}
	}
	mu.Lock()
	n := len(got)
	mu.Unlock()
	if n == 0 {
		t.Error("nothing reached the daemon; the shim should forward payloads it cannot parse")
	}
}

// A hung daemon is the dangerous case: without its own deadline the shim would
// sit in the user's hook until Claude Code gave up. Rule 3 caps a non-Stop
// event under a second, so this must return on the shim's budget, not the
// server's.
func TestHungDaemonReturnsWithinBudget(t *testing.T) {
	dir := isolate(t)
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-release // never answers until the test lets go
	}))
	defer srv.Close()
	defer close(release)
	runtimeFor(t, dir, srv.URL)

	start := time.Now()
	out := runShim(t, hookBody(t, "PreToolUse"), 3*time.Second)
	elapsed := time.Since(start)

	if out != "" {
		t.Errorf("wrote %q while the daemon hung; want nothing", out)
	}
	// The budget is 900ms; allow slack for a loaded CI runner but stay well
	// under the point where a user would notice their session stalling.
	if elapsed > 2*time.Second {
		t.Errorf("took %s against a hung daemon; rule 3 caps an ordinary hook under a second", elapsed)
	}
}

// Stop is the one event whose answer is used: the daemon may return a decision
// that Claude Code acts on, so a valid JSON body is passed through verbatim.
func TestStopDecisionReachesStdout(t *testing.T) {
	dir := isolate(t)
	decision := `{"hookSpecificOutput":{"hookEventName":"Stop","decision":"block","reason":"keep going"}}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer test-token" {
			t.Errorf("Authorization = %q; the daemon rejects an unauthenticated shim", got)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, decision)
	}))
	defer srv.Close()
	runtimeFor(t, dir, srv.URL)

	out := runShim(t, hookBody(t, "Stop"), 7*time.Second)
	if out != decision {
		t.Errorf("stdout = %q; want the decision passed through unchanged", out)
	}
}

// Anything that is not valid JSON must never reach stdout: Claude Code parses
// what the shim prints, so garbage there is worse than silence. This covers a
// daemon mid-upgrade, a proxy error page, a truncated body.
func TestNonJSONReplyIsNeverPrinted(t *testing.T) {
	for _, reply := range []string{
		"<html>502 Bad Gateway</html>",
		"OK",
		`{"unterminated": `,
		"   ",
		"",
	} {
		t.Run(strings.TrimSpace(reply), func(t *testing.T) {
			dir := isolate(t)
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				fmt.Fprint(w, reply)
			}))
			defer srv.Close()
			runtimeFor(t, dir, srv.URL)

			if out := runShim(t, hookBody(t, "Stop"), 7*time.Second); out != "" {
				t.Errorf("printed %q for reply %q; only valid JSON may reach stdout", out, reply)
			}
		})
	}
}

// A non-200 means the daemon did not accept the event. Its body is an error
// message, not a hook decision, and printing it would feed Claude Code
// something it never asked for.
func TestErrorStatusIsNotPrinted(t *testing.T) {
	for _, code := range []int{400, 401, 403, 500, 503} {
		t.Run(strconv.Itoa(code), func(t *testing.T) {
			dir := isolate(t)
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(code)
				fmt.Fprint(w, `{"error":"nope"}`)
			}))
			defer srv.Close()
			runtimeFor(t, dir, srv.URL)

			if out := runShim(t, hookBody(t, "Stop"), 7*time.Second); out != "" {
				t.Errorf("printed %q on HTTP %d; an error body is not a decision", out, code)
			}
		})
	}
}

// Only Stop consumes a reply. Answering another event must not put anything on
// stdout, whatever the daemon says.
func TestNonStopIgnoresTheReply(t *testing.T) {
	dir := isolate(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"decision":"block"}`)
	}))
	defer srv.Close()
	runtimeFor(t, dir, srv.URL)

	if out := runShim(t, hookBody(t, "PostToolUse"), 3*time.Second); out != "" {
		t.Errorf("PostToolUse printed %q; only Stop consumes a reply", out)
	}
}

// A corrupt runtime.json is what a half-written file or a version skew looks
// like. There is no port to reach, so the shim drops the event.
func TestCorruptRuntimeIsSilent(t *testing.T) {
	for name, content := range map[string]string{
		"not json":  "{{{",
		"empty":     "",
		"no port":   `{"token":"x"}`,
		"port zero": `{"port":0,"token":"x"}`,
	} {
		t.Run(name, func(t *testing.T) {
			dir := isolate(t)
			if err := os.WriteFile(config.RuntimePath(dir), []byte(content), 0o600); err != nil {
				t.Fatal(err)
			}
			if out := runShim(t, hookBody(t, "PreToolUse"), 3*time.Second); out != "" {
				t.Errorf("printed %q with runtime.json = %q", out, content)
			}
		})
	}
}

// The daemon must not be handed an unbounded body: a runaway payload should be
// clipped rather than buffered whole and forwarded.
func TestOversizedStdinIsClipped(t *testing.T) {
	dir := isolate(t)
	var size int
	var mu sync.Mutex
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		mu.Lock()
		size = len(b)
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	runtimeFor(t, dir, srv.URL)

	huge := `{"hook_event_name":"PreToolUse","pad":"` + strings.Repeat("x", maxStdin+1000) + `"}`
	if out := runShim(t, huge, 5*time.Second); out != "" {
		t.Errorf("printed %q for an oversized payload", out)
	}
	mu.Lock()
	got := size
	mu.Unlock()
	if got > maxStdin {
		t.Errorf("forwarded %d bytes; the cap is %d", got, maxStdin)
	}
}

// Debug logging is opt-in. Without the env var set, a failing shim must leave
// nothing behind — a hook that quietly grows a log file on every tool call is
// its own kind of breakage.
func TestNoDebugLogUnlessAsked(t *testing.T) {
	dir := isolate(t)
	runShim(t, hookBody(t, "PreToolUse"), 2*time.Second) // fails: no daemon
	if _, err := os.Stat(config.HookDebugLogPath(dir)); err == nil {
		t.Error("wrote a debug log without CAPROCK_HOOK_DEBUG set")
	}
}

// And with it set, the diagnosis has to actually be there — this is the only
// way a user can tell us why their hooks are silent.
func TestDebugLogWhenAsked(t *testing.T) {
	dir := isolate(t)
	t.Setenv(DebugEnv, "1")
	runShim(t, hookBody(t, "PreToolUse"), 2*time.Second) // fails: no daemon
	b, err := os.ReadFile(config.HookDebugLogPath(dir))
	if err != nil {
		t.Fatalf("no debug log with %s set: %v", DebugEnv, err)
	}
	if !strings.Contains(string(b), "runtime.json") {
		t.Errorf("debug log does not say why it gave up: %q", b)
	}
}

// A panic anywhere inside Run must not escape. The shim runs in the user's
// hook: an unrecovered panic writes a goroutine dump to stderr and exits
// non-zero, which is precisely the "breaks the session" outcome rule 3 forbids.
//
// The recover() in Run has no other test — every failure above is an ordinary
// error return — so this drives a panic through the one input that reaches it:
// a reader that fails mid-stream after handing over data.
func TestPanicInsideRunIsContained(t *testing.T) {
	isolate(t)
	var out bytes.Buffer
	done := make(chan any, 1)
	go func() {
		// If Run lets a panic through, it unwinds into this goroutine and the
		// recover here sees it; if Run contains it, this stays nil.
		defer func() { done <- recover() }()
		Run(panicReader{}, &out)
	}()
	select {
	case r := <-done:
		if r != nil {
			t.Fatalf("a panic escaped Run: %v — the shim must never fail the session", r)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not return")
	}
	if out.Len() != 0 {
		t.Errorf("wrote %q while panicking", out.String())
	}
}

// panicReader panics partway through being read, standing in for any panic
// raised inside Run's body.
type panicReader struct{}

func (p panicReader) Read([]byte) (int, error) {
	panic("boom from stdin")
}
