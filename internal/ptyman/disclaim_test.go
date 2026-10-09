package ptyman

import (
	"os"
	"runtime"
	"strings"
	"testing"

	"github.com/dspv/caprock/internal/disclaim"
)

// TestMain lets this test binary act as the disclaim trampoline, the way the
// caprock binary does.
func TestMain(m *testing.M) {
	disclaim.Main()
	os.Exit(m.Run())
}

// A session started through the trampoline must still own its terminal: the
// trampoline re-executes in place, so the shell keeps the session and
// controlling terminal the PTY set up, and its job control works.
func TestADisclaimedSessionKeepsItsTerminal(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("only macOS disclaims")
	}
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	defer disclaim.EnableWith(exe)()
	s := spawn(t, shellSpec(`tty; [ -t 0 ] && echo stdin-is-tty; ps -o pgid=,tpgid= -p $$`))
	out := drain(t, s.Output())
	if err := s.Wait(); err != nil {
		t.Fatalf("wait: %v; output %q", err, out)
	}
	if !strings.Contains(out, "/dev/ttys") || !strings.Contains(out, "stdin-is-tty") {
		t.Fatalf("the shell lost its terminal: %q", out)
	}
	lines := strings.Split(strings.TrimSpace(strings.ReplaceAll(out, "\r", "")), "\n")
	f := strings.Fields(lines[len(lines)-1])
	if len(f) != 2 || f[0] != f[1] {
		t.Fatalf("the shell is not the terminal's foreground group (pgid tpgid): %q", out)
	}
}
