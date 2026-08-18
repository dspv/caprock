//go:build ptyspike

// T0 — the ConPTY spike. Proves the go-pty backend can spawn a process, stream
// its output, accept input, resize, and kill cleanly on macOS / Linux / Windows.
// Runs on the CI matrix as an informational job (`-tags ptyspike`); the written
// go/no-go note lives in .ai/14-build-status.md.
package ptyman

import (
	"bufio"
	"context"
	"os/exec"
	"runtime"
	"strings"
	"testing"
	"time"
)

func echoSpec() Spec {
	if runtime.GOOS == "windows" {
		return Spec{Command: "cmd.exe", Args: []string{"/Q", "/C", "echo hello-from-pty & set /p x=prompt: & echo got:%x% & ping -n 30 127.0.0.1 > nul"}}
	}
	return Spec{Command: "/bin/sh", Args: []string{"-c", "echo hello-from-pty; read x; echo got:$x; sleep 30"}}
}

func TestSpikeSpawnStreamWriteKill(t *testing.T) {
	if runtime.GOOS != "windows" {
		if _, err := exec.LookPath("sh"); err != nil {
			t.Skip("no sh")
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	s, err := New().Spawn(ctx, echoSpec())
	if err != nil {
		t.Fatalf("spawn: %v", err)
	}
	defer s.Close()
	if s.PID() == 0 {
		t.Fatal("no pid")
	}
	lines := make(chan string, 64)
	go func() {
		sc := bufio.NewScanner(s.Output())
		for sc.Scan() {
			lines <- strings.TrimSpace(sc.Text())
		}
		close(lines)
	}()
	waitLine := func(substr string) {
		t.Helper()
		deadline := time.After(10 * time.Second)
		for {
			select {
			case l, ok := <-lines:
				if !ok {
					t.Fatalf("output ended before %q", substr)
				}
				if strings.Contains(l, substr) {
					return
				}
			case <-deadline:
				t.Fatalf("timeout waiting for %q", substr)
			}
		}
	}
	waitLine("hello-from-pty")
	if err := s.Resize(100, 30); err != nil {
		t.Fatalf("resize: %v", err)
	}
	if _, err := s.Write([]byte("typed-input\r\n")); err != nil {
		t.Fatalf("write: %v", err)
	}
	waitLine("got:typed-input")
	// Pause holds input everywhere; POSIX also stops the process.
	if err := s.Signal(SignalPause); err != nil {
		t.Fatalf("pause: %v", err)
	}
	if !s.Paused() {
		t.Fatal("not paused")
	}
	if err := s.Signal(SignalResume); err != nil {
		t.Fatalf("resume: %v", err)
	}
	start := time.Now()
	if err := s.Signal(SignalKill); err != nil {
		t.Fatalf("kill: %v", err)
	}
	done := make(chan error, 1)
	go func() { done <- s.Wait() }()
	select {
	case <-done:
		t.Logf("killed and reaped in %s", time.Since(start))
	case <-time.After(10 * time.Second):
		t.Fatal("process did not exit after kill")
	}
	if err := s.Close(); err != nil {
		t.Logf("close after exit: %v (tolerated)", err)
	}
}
