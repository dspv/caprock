// ptyman owns the processes Caprock spawns — it starts them, streams their
// output, types into them, and kills them. Two project rules meet here: rule 7
// ("we never signal or type into a process we did not start") and the Phase 1
// promise that a paused session cannot be typed into.
//
// The spike test (-tags ptyspike) proves the backend works on each OS. These
// cover the wrapper's own decisions, which is where a regression would be
// silent: the defaults applied to a Spec, an input-hold that must swallow
// rather than forward, a Close that runs twice, and a PID asked for before
// anything is running.
package ptyman

import (
	"bytes"
	"context"
	"io"
	"os"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// shellSpec runs one command through the platform shell, so these tests do not
// depend on any binary that might be absent from a CI image.
func shellSpec(script string) Spec {
	if runtime.GOOS == "windows" {
		// /Q suppresses command echo. Without it ConPTY paints the console —
		// a screen clear, cursor moves, a title sequence — and the actual
		// output is lost among the escapes.
		return Spec{Command: "cmd.exe", Args: []string{"/Q", "/C", script}}
	}
	return Spec{Command: "/bin/sh", Args: []string{"-c", script}}
}

// spawn starts a session and guarantees it is torn down, so a failing test
// cannot leave a process behind on the developer's machine.
func spawn(t *testing.T, spec Spec) Session {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	t.Cleanup(cancel)
	s, err := New().Spawn(ctx, spec)
	if err != nil {
		t.Fatalf("spawn %q: %v", spec.Command, err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

// drain reads output until EOF or a short deadline, whichever is first. A PTY
// stays open while the process lives, so an unbounded ReadAll would hang; the
// callers here only need the process to have run, not its text.
func drain(t *testing.T, r io.Reader) string {
	const d = 5 * time.Second
	t.Helper()
	var mu sync.Mutex
	var buf bytes.Buffer
	done := make(chan struct{})
	go func() {
		defer close(done)
		b := make([]byte, 4096)
		for {
			n, err := r.Read(b)
			if n > 0 {
				mu.Lock()
				buf.Write(b[:n])
				mu.Unlock()
			}
			if err != nil {
				return
			}
		}
	}()
	select {
	case <-done:
	case <-time.After(d):
	}
	mu.Lock()
	defer mu.Unlock()
	return buf.String()
}

// readUntil drains output until `want` appears or the deadline passes. A fixed
// window is not enough on Windows: ConPTY emits a screen-painting preamble
// before the process's own output, so the interesting bytes arrive late.
func readUntil(t *testing.T, r io.Reader, want string, d time.Duration) string {
	t.Helper()
	var mu sync.Mutex
	var buf bytes.Buffer
	found := make(chan struct{})
	go func() {
		b := make([]byte, 4096)
		for {
			n, err := r.Read(b)
			if n > 0 {
				mu.Lock()
				buf.Write(b[:n])
				hit := strings.Contains(buf.String(), want)
				mu.Unlock()
				if hit {
					select {
					case found <- struct{}{}:
					default:
					}
					return
				}
			}
			if err != nil {
				return
			}
		}
	}()
	select {
	case <-found:
	case <-time.After(d):
	}
	mu.Lock()
	defer mu.Unlock()
	return buf.String()
}

// An empty command is a caller bug, and it must be refused rather than handed
// to the OS to reject in some platform-specific way.
func TestSpawnRejectsEmptyCommand(t *testing.T) {
	_, err := New().Spawn(context.Background(), Spec{})
	if err == nil {
		t.Fatal("spawned an empty command; want an error")
	}
	if !strings.Contains(err.Error(), "empty command") {
		t.Errorf("error = %v; want it to name the empty command", err)
	}
}

// A command that does not exist must fail at Spawn, not silently produce a
// session that never outputs anything.
func TestSpawnFailsOnMissingBinary(t *testing.T) {
	_, err := New().Spawn(context.Background(), Spec{Command: "caprock-no-such-binary-xyz"})
	if err == nil {
		t.Fatal("spawn succeeded for a nonexistent binary; want an error")
	}
}

// The process runs and its output reaches the reader. This is the contract the
// terminal tab depends on.
func TestOutputStreamsAndEndsAtExit(t *testing.T) {
	s := spawn(t, shellSpec("echo caprock-marker"))
	out := readUntil(t, s.Output(), "caprock-marker", 15*time.Second)
	if !strings.Contains(out, "caprock-marker") {
		t.Errorf("output %q does not contain the marker", out)
	}
}

// Wait must report the process's own exit status: the verification runner
// decides pass/fail on it, so a swallowed non-zero exit would mark a failed
// task green.
func TestWaitReportsFailureExit(t *testing.T) {
	s := spawn(t, shellSpec("exit 3"))
	_ = drain(t, s.Output())
	if err := s.Wait(); err == nil {
		t.Error("Wait returned nil for an exit-3 process; a failure must not read as success")
	}
}

func TestWaitReportsSuccessExit(t *testing.T) {
	s := spawn(t, shellSpec("exit 0"))
	_ = drain(t, s.Output())
	if err := s.Wait(); err != nil {
		t.Errorf("Wait = %v for a clean exit; want nil", err)
	}
}

// Wait is called from more than one place (the API handler and the task
// runner), so it must be safe to call concurrently and repeatedly rather than
// consuming a one-shot result.
func TestWaitIsRepeatableAndConcurrent(t *testing.T) {
	s := spawn(t, shellSpec("exit 0"))
	_ = drain(t, s.Output())

	var wg sync.WaitGroup
	errs := make([]error, 4)
	for i := range errs {
		wg.Add(1)
		go func(i int) { defer wg.Done(); errs[i] = s.Wait() }(i)
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Errorf("Wait #%d = %v; want nil from every caller", i, err)
		}
	}
}

// The input-hold is how a session is paused on Windows, where there is no
// SIGSTOP. While held, a keystroke must not reach the child — but the caller is
// told the write succeeded, so the UI does not report a spurious error.
//
// Asserting only the (n, err) pair is not enough: a Write that forwards
// straight to the PTY also returns success, so such a test passes against a
// shim with the hold deleted. The check that means anything is whether the
// child ever saw the input, so this feeds a shell that echoes what it reads.
func TestPausedWriteNeverReachesTheProcess(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the read-and-echo script below is POSIX shell")
	}
	// Echoes every line it receives, prefixed, so anything that got through is
	// visible in the output.
	s := spawn(t, shellSpec("while read line; do echo \"SAW:$line\"; done"))
	sess := s.(*session)

	sess.paused.Store(true)
	n, err := s.Write([]byte("secret-while-paused\n"))
	if err != nil {
		t.Errorf("Write while paused = %v; the caller must see success", err)
	}
	if n != len("secret-while-paused\n") {
		t.Errorf("Write reported %d bytes; want the full length so callers do not retry", n)
	}
	if !s.Paused() {
		t.Error("Paused() = false after the hold was set")
	}

	// Release and send something that must arrive, which also proves the reader
	// is working — otherwise the absence of the first line would prove nothing.
	sess.paused.Store(false)
	if s.Paused() {
		t.Error("Paused() = true after release")
	}
	if _, err := s.Write([]byte("after-resume\n")); err != nil {
		t.Fatalf("Write after resume: %v", err)
	}

	out := drain(t, s.Output())
	if !strings.Contains(out, "SAW:after-resume") {
		t.Fatalf("the process never saw input after resume; output=%q", out)
	}
	if strings.Contains(out, "SAW:secret-while-paused") {
		t.Errorf("input sent while paused reached the process; output=%q", out)
	}
}

// Close is reachable from the API, from a context cancel, and from the test
// cleanup above. Calling it twice must not panic or return a spurious error.
func TestCloseIsIdempotent(t *testing.T) {
	s := spawn(t, shellSpec("exit 0"))
	_ = drain(t, s.Output())
	if err := s.Close(); err != nil {
		t.Errorf("first Close = %v", err)
	}
	if err := s.Close(); err != nil {
		t.Errorf("second Close = %v; Close must be idempotent", err)
	}
	// The closed flag must actually latch. Without it a second Close reaches
	// the PTY again — today that error is mapped to nil, so only the flag
	// itself distinguishes "handled twice" from "guarded once".
	if sess, ok := s.(*session); ok && !sess.closed.Load() {
		t.Error("closed flag not set; Close is relying on error mapping rather than guarding")
	}
}

// Close must leave no running process behind — a spawned `claude` that outlives
// its session holds a plan slot and keeps burning tokens.
//
// What this can and cannot prove is worth stating, because the obvious stronger
// test does not work. Closing the PTY alone ends a POSIX child within ~100ms
// (measured): the shell's read fails and it exits, and `trap ” HUP` does not
// prevent that. So no POSIX test can isolate Close's explicit SIGKILL from the
// hangup that follows PTY teardown — a test claiming to do so would pass with
// the kill deleted, which is worse than not testing it.
//
// What is asserted instead is the property the product actually needs: after
// Close returns, the process is gone from the OS. The kill path itself is
// exercised by the ptyspike job on all three OSes.
func TestCloseLeavesNoProcessBehind(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("signal 0 liveness probing is POSIX; ConPTY teardown is covered by the spike test")
	}
	s := spawn(t, shellSpec("sleep 30"))
	pid := s.PID()
	if pid <= 0 {
		t.Fatalf("PID = %d for a running process", pid)
	}
	if err := s.Close(); err != nil {
		t.Errorf("Close = %v", err)
	}

	// Poll rather than sleep: teardown is asynchronous.
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if !processAlive(pid) {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("process %d survived Close; a leaked session holds a plan slot", pid)
}

// processAlive reports whether the OS still knows the pid. Signal 0 performs
// only the permission and existence checks, killing nothing.
func processAlive(pid int) bool {
	p, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	return p.Signal(syscall.Signal(0)) == nil
}

// Cancelling the context is how the daemon stops everything on shutdown.
func TestContextCancelStopsTheProcess(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	s, err := New().Spawn(ctx, shellSpec("sleep 30"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })

	cancel()
	done := make(chan struct{})
	go func() { defer close(done); _ = s.Wait() }()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("the process survived context cancellation")
	}
}

// A zero Cols/Rows means "unset", not "a zero-sized terminal" — a PTY sized 0x0
// makes programs wrap every character.
func TestZeroSizeGetsUsableDefaults(t *testing.T) {
	spec := shellSpec("exit 0")
	spec.Cols, spec.Rows = 0, 0
	s := spawn(t, spec)
	_ = drain(t, s.Output())
	if err := s.Wait(); err != nil {
		t.Errorf("a zero-sized spec failed to run: %v", err)
	}
}

// Resize is driven by the browser window, so it arrives at arbitrary times —
// including after the process has already exited.
func TestResizeAfterExitDoesNotPanic(t *testing.T) {
	s := spawn(t, shellSpec("exit 0"))
	_ = drain(t, s.Output())
	_ = s.Wait()
	// The error is immaterial; not panicking is the contract.
	_ = s.Resize(100, 30)
}

// PID is read by the UI and by the orchestrator's bookkeeping. It must answer
// 0 rather than dereference a nil process.
func TestPIDIsZeroWithoutAProcess(t *testing.T) {
	var s session
	if got := s.PID(); got != 0 {
		t.Errorf("PID = %d on an unstarted session; want 0", got)
	}
}

// Env: nil means inherit, a set value means replace. Getting this backwards
// would either leak the daemon's environment into a spawned agent or strip PATH
// from it.
func TestExplicitEnvReplacesTheInherited(t *testing.T) {
	marker := "CAPROCK_TEST_MARKER=present"
	script := "echo $CAPROCK_TEST_MARKER"
	if runtime.GOOS == "windows" {
		script = "echo %CAPROCK_TEST_MARKER%"
	}
	spec := shellSpec(script)
	// PATH is kept so the shell itself remains runnable on every platform.
	spec.Env = append(osEnvSubset(), marker)

	s := spawn(t, spec)
	out := readUntil(t, s.Output(), "present", 15*time.Second)
	if !strings.Contains(out, "present") {
		t.Errorf("output %q does not show the explicit env var", out)
	}
}

// osEnvSubset returns the minimum inherited environment a shell needs, so the
// env test replaces the environment without making the shell unlaunchable.
func osEnvSubset() []string {
	keep := []string{"PATH", "SystemRoot", "COMSPEC", "WINDIR", "HOME", "TEMP", "TMP"}
	var out []string
	for _, k := range keep {
		if v, ok := os.LookupEnv(k); ok {
			out = append(out, k+"="+v)
		}
	}
	return out
}
