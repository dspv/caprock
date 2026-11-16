package main

import (
	"bytes"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/config"
)

func runShimArgs(t *testing.T, dataDir, stdin string, env []string, args ...string) (string, time.Duration) {
	t.Helper()
	cmd := exec.Command(shimBin, args...)
	cmd.Env = append(append(os.Environ(), config.EnvDataDir+"="+dataDir), env...)
	cmd.Stdin = bytes.NewBufferString(stdin)
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	start := time.Now()
	if err := cmd.Run(); err != nil {
		t.Fatalf("shim exited non-zero: %v (stderr=%q)", err, errb.String())
	}
	if errb.Len() != 0 {
		t.Fatalf("shim wrote to stderr: %q", errb.String())
	}
	return out.String(), time.Since(start)
}

// Cursor reads a hook's stdout as its answer, so `caprock-hook cursor`
// always prints the neutral one — with no daemon, with a wedged one, with
// nothing on stdin — and exits 0 within its budget (ADR-095, rule 3).
func TestCursorShimAlwaysAnswersNeutrally(t *testing.T) {
	dir := t.TempDir() // no runtime.json
	for payload, want := range map[string]string{
		`{"conversation_id":"c","hook_event_name":"beforeSubmitPrompt","prompt":"hi"}`: `{"continue":true}`,
		`{"conversation_id":"c","hook_event_name":"stop","status":"completed"}`:        `{}`,
		`{"conversation_id":"c","hook_event_name":"postToolUse"}`:                      `{}`,
		``: `{}`,
	} {
		out, el := runShimArgs(t, dir, payload, nil, "cursor")
		if strings.TrimSpace(out) != want || el > shimBudget {
			t.Fatalf("%s: out=%q elapsed=%s", payload, out, el)
		}
	}
	// A daemon that accepts and never answers.
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	done := make(chan struct{})
	defer close(done)
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) { <-done; _ = c.Close() }(c)
		}
	}()
	_ = config.WriteRuntime(dir, config.Runtime{Port: l.Addr().(*net.TCPAddr).Port, Token: "t"})
	out, el := runShimArgs(t, dir, `{"conversation_id":"c","hook_event_name":"beforeSubmitPrompt"}`, nil, "cursor")
	if strings.TrimSpace(out) != `{"continue":true}` || el > shimBudget {
		t.Fatalf("wedged daemon: out=%q elapsed=%s", out, el)
	}
}

func TestCursorShimForwardsToItsOwnEndpoint(t *testing.T) {
	dir := t.TempDir()
	type got struct{ path, auth, session string }
	ch := make(chan got, 2)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ch <- got{r.URL.Path, r.Header.Get("Authorization"), r.Header.Get("X-Caprock-Session")}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()
	port, _ := strconv.Atoi(srv.URL[len("http://127.0.0.1:"):])
	if err := config.WriteRuntime(dir, config.Runtime{Port: port, Token: "tok"}); err != nil {
		t.Fatal(err)
	}
	out, _ := runShimArgs(t, dir, `{"conversation_id":"c","hook_event_name":"stop"}`, []string{"CAPROCK_CURSOR_SESSION=cap-1"}, "cursor")
	if strings.TrimSpace(out) != `{}` {
		t.Fatalf("out=%q", out)
	}
	if g := <-ch; g.path != "/v1/hook/cursor" || g.auth != "Bearer tok" || g.session != "cap-1" {
		t.Fatalf("got %+v", g)
	}
}
