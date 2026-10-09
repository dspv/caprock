package disclaim

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// TestMain lets the test binary stand in for caprock: started with Arg, it
// becomes the trampoline.
func TestMain(m *testing.M) {
	Main()
	os.Exit(m.Run())
}

func TestWrapLeavesCommandsAloneUntilEnabled(t *testing.T) {
	name, args := Wrap("sh", []string{"-c", "true"})
	if name != "sh" || len(args) != 2 || args[0] != "-c" {
		t.Fatalf("not enabled, Wrap changed the command: %q %q", name, args)
	}
}

func TestWrapLeavesAMissingProgramToFailAsBefore(t *testing.T) {
	defer EnableWith("/opt/caprock")()
	missing := filepath.Join(t.TempDir(), "no-such-program")
	name, args := Wrap(missing, []string{"x"})
	if name != missing || len(args) != 1 {
		t.Fatalf("a missing program was wrapped: %q %q", name, args)
	}
}

func TestWrapRoutesThroughTheTrampoline(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("no trampoline on Windows")
	}
	defer EnableWith("/opt/caprock")()
	name, args := Wrap("sh", []string{"-c", "true"})
	if name != "/opt/caprock" {
		t.Fatalf("the trampoline is this binary, got %q", name)
	}
	if len(args) != 5 || args[0] != Arg || !filepath.IsAbs(args[1]) || args[2] != "sh" || args[3] != "-c" || args[4] != "true" {
		t.Fatalf("want [Arg /abs/sh sh -c true], got %q", args)
	}
}

func TestEnableIsANoOpOffMacOS(t *testing.T) {
	if supported {
		t.Skip("macOS enables")
	}
	Enable()
	if name, _ := Wrap("go", nil); name != "go" {
		t.Fatalf("Enable wrapped a command off macOS: %q", name)
	}
}
