//go:build ptyspike

// What a keystroke actually becomes, end to end through a real PTY.
//
// The milestone's acceptance criterion for raw input — "arrows, Ctrl+C and Tab
// arrive verbatim" — cannot be checked against `claude`: what a TUI does with a
// sequence is invisible from outside, and spawning it costs money. So this
// drives `testdata/ptyecho`, which prints the bytes it received, and asserts on
// those.
//
// It also settles the question the docs would not: which sequence Claude Code
// sees when a person presses Shift+Enter. The answer this pins is that we send
// a line feed, because a line feed is the one Claude Code's own documentation
// says works in every terminal with no setup — CSI u needs the kitty keyboard
// protocol negotiated, and this terminal never negotiates it.
package ptyman

import (
	"context"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// buildEcho compiles the fixture into a temp dir and returns its path.
func buildEcho(t *testing.T) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the fixture sets raw mode with stty, which Windows does not have")
	}
	bin := filepath.Join(t.TempDir(), "ptyecho")
	// The fixture lives at the repository root, two levels up from here.
	cmd := exec.Command("go", "build", "-o", bin, "./testdata/ptyecho")
	cmd.Dir = "../.."
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("building the fixture: %v\n%s", err, out)
	}
	return bin
}

func TestKeystrokesArriveVerbatim(t *testing.T) {
	bin := buildEcho(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	s, err := New().Spawn(ctx, Spec{Command: bin, Cols: 100, Rows: 30})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Signal(SignalKill) }()

	var got strings.Builder
	read := make(chan struct{})
	go func() {
		defer close(read)
		r := s.Output()
		buf := make([]byte, 4096)
		for {
			n, err := r.Read(buf)
			if n > 0 {
				got.WriteString(string(buf[:n]))
			}
			if err != nil {
				return
			}
		}
	}()

	// Let the fixture reach raw mode before anything is typed at it.
	deadline := time.Now().Add(3 * time.Second)
	for !strings.Contains(got.String(), "ready") && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if !strings.Contains(got.String(), "ready") {
		t.Fatalf("the fixture never reported ready; got %q", got.String())
	}

	// Each of these is a key a person presses in Claude Code, and each must
	// reach the process as itself.
	cases := []struct {
		name  string
		send  string
		wants string // as the fixture prints it: lowercase hex, space separated
	}{
		{"the newline every modifier now sends", "\n", "0a"},
		{"arrow up", "\x1b[A", "1b 5b 41"},
		{"ctrl+c", "\x03", "03"},
		{"tab", "\t", "09"},
		{"a multi-byte paste", "héllo", "68 c3 a9 6c 6c 6f"},
	}
	for _, c := range cases {
		if _, err := s.Write([]byte(c.send)); err != nil {
			t.Fatalf("%s: write: %v", c.name, err)
		}
		time.Sleep(120 * time.Millisecond)
	}
	_, _ = s.Write([]byte("q"))
	select {
	case <-read:
	case <-time.After(3 * time.Second):
	}

	out := got.String()
	for _, c := range cases {
		if !strings.Contains(out, "got "+c.wants) {
			t.Errorf("%s: %q did not arrive as %q\n--- received ---\n%s", c.name, c.send, c.wants, out)
		}
	}
}

// The size the daemon is told about has to reach the process, because a TUI
// draws itself to it. Nothing called Resize at all until this was wired up:
// the PTY kept the size it was born with, 120x40 by default, and Claude Code
// laid its menus out for a screen the user did not have.
func TestResizeReachesTheProcess(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the fixture needs a POSIX shell")
	}
	// `stty size` prints "rows cols" as the kernel knows them, which is the
	// only witness that matters — asserting on our own struct would prove
	// nothing.
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	s, err := New().Spawn(ctx, Spec{
		Command: "/bin/sh",
		Args:    []string{"-c", "sleep 0.6; stty size; sleep 0.6; stty size"},
		Cols:    100, Rows: 30,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Signal(SignalKill) }()

	var got strings.Builder
	done := make(chan struct{})
	go func() {
		defer close(done)
		r := s.Output()
		buf := make([]byte, 4096)
		for {
			n, err := r.Read(buf)
			if n > 0 {
				got.WriteString(string(buf[:n]))
			}
			if err != nil {
				return
			}
		}
	}()

	time.Sleep(900 * time.Millisecond)
	if err := s.Resize(143, 38); err != nil {
		t.Fatalf("resize: %v", err)
	}
	select {
	case <-done:
	case <-time.After(4 * time.Second):
	}

	out := got.String()
	if !strings.Contains(out, "30 100") {
		t.Errorf("the process did not start at 100x30:\n%s", out)
	}
	if !strings.Contains(out, "38 143") {
		t.Errorf("the resize did not reach the process:\n%s", out)
	}
}
