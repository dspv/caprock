package main

import (
	"bytes"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/config"
)

var shimBin string

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "caprock-hook-test")
	if err != nil {
		panic(err)
	}
	shimBin = filepath.Join(dir, "caprock-hook")
	if runtime.GOOS == "windows" {
		shimBin += ".exe"
	}
	build := exec.Command("go", "build", "-o", shimBin, ".")
	build.Stderr = os.Stderr
	if err := build.Run(); err != nil {
		panic("build shim: " + err.Error())
	}
	code := m.Run()
	_ = os.RemoveAll(dir)
	os.Exit(code)
}

func runShim(t *testing.T, dataDir string, stdin string) (stdout string, elapsed time.Duration) {
	t.Helper()
	cmd := exec.Command(shimBin)
	cmd.Env = append(os.Environ(), config.EnvDataDir+"="+dataDir)
	cmd.Stdin = bytes.NewBufferString(stdin)
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	start := time.Now()
	err := cmd.Run()
	elapsed = time.Since(start)
	if err != nil {
		t.Fatalf("shim exited non-zero: %v (stderr=%q)", err, errb.String())
	}
	if errb.Len() != 0 {
		t.Fatalf("shim wrote to stderr: %q", errb.String())
	}
	return out.String(), elapsed
}

func TestShimDaemonDownExitsZeroFastAndSilent(t *testing.T) {
	dir := t.TempDir() // no runtime.json
	out, el := runShim(t, dir, `{"session_id":"s","hook_event_name":"PreToolUse"}`)
	if out != "" || el > time.Second {
		t.Fatalf("out=%q elapsed=%s", out, el)
	}
	// runtime.json present but nobody listening.
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	port := l.Addr().(*net.TCPAddr).Port
	_ = l.Close()
	_ = config.WriteRuntime(dir, config.Runtime{Port: port, Token: "t"})
	out, el = runShim(t, dir, `{"session_id":"s","hook_event_name":"PreToolUse"}`)
	if out != "" || el > time.Second {
		t.Fatalf("closed port: out=%q elapsed=%s", out, el)
	}
	// Even a Stop event must not hang past its 5s budget with a dead port (connect fails fast).
	out, el = runShim(t, dir, `{"session_id":"s","hook_event_name":"Stop"}`)
	if out != "" || el > 2*time.Second {
		t.Fatalf("stop on closed port: out=%q elapsed=%s", out, el)
	}
}

func TestShimPostsWithBearerAndRelaysStopDecision(t *testing.T) {
	dir := t.TempDir()
	type got struct {
		auth string
		body []byte
	}
	ch := make(chan got, 4)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		ch <- got{r.Header.Get("Authorization"), b}
		if bytes.Contains(b, []byte(`"Stop"`)) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"decision":"block","reason":"process your inbox"}`))
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()
	port, _ := strconv.Atoi(srv.URL[len("http://127.0.0.1:"):])
	if err := config.WriteRuntime(dir, config.Runtime{Port: port, Token: "tok123"}); err != nil {
		t.Fatal(err)
	}
	payload := `{"session_id":"s","hook_event_name":"PreToolUse","tool_name":"Bash"}`
	out, _ := runShim(t, dir, payload)
	if out != "" {
		t.Fatalf("non-Stop event printed %q", out)
	}
	g := <-ch
	if g.auth != "Bearer tok123" || string(g.body) != payload {
		t.Fatalf("got %+v", g)
	}
	out, _ = runShim(t, dir, `{"session_id":"s","hook_event_name":"Stop"}`)
	if out != `{"decision":"block","reason":"process your inbox"}` {
		t.Fatalf("stop relay: %q", out)
	}
	<-ch
	// Empty stdin: nothing sent, exit 0.
	out, _ = runShim(t, dir, "")
	if out != "" {
		t.Fatal("empty stdin produced output")
	}
	select {
	case g := <-ch:
		t.Fatalf("empty stdin was posted: %+v", g)
	case <-time.After(200 * time.Millisecond):
	}
}
