package disclaim

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestThisMacOSOffersTheAttribute(t *testing.T) {
	if !Available() {
		t.Fatal("responsibility_spawnattrs_setdisclaim not found; every macOS since 10.14 has it")
	}
}

// The trampoline must be invisible to the caller: the program it becomes keeps
// the pid the caller started, the directory, the environment, the stdio and
// the exit status.
func TestTheTrampolineBecomesTheProgram(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	defer EnableWith(exe)()
	dir := t.TempDir()
	name, args := Wrap("/bin/sh", []string{"-c", `echo "$$"; pwd -P; echo "$CAPROCK_DISCLAIM_PROBE"; exit 3`})
	if name != exe {
		t.Fatalf("not wrapped: %q", name)
	}
	cmd := exec.Command(name, args...)
	cmd.Dir = dir
	cmd.Env = []string{"PATH=/usr/bin:/bin", "CAPROCK_DISCLAIM_PROBE=σ-ok"}
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	err = cmd.Run()
	var ee *exec.ExitError
	if !errors.As(err, &ee) || ee.ExitCode() != 3 {
		t.Fatalf("want exit 3 from the program, got %v; output %q", err, out.String())
	}
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 3 {
		t.Fatalf("want 3 lines, got %q", out.String())
	}
	if lines[0] != strconv.Itoa(cmd.Process.Pid) {
		t.Errorf("the program runs as pid %s, the caller started %d", lines[0], cmd.Process.Pid)
	}
	real, _ := filepath.EvalSymlinks(dir)
	if lines[1] != real {
		t.Errorf("directory %q, want %q", lines[1], real)
	}
	if lines[2] != "σ-ok" {
		t.Errorf("environment lost: %q", lines[2])
	}
}

func TestTheTrampolineReportsAProgramItCannotStart(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	notExec := filepath.Join(dir, "plain")
	if err := os.WriteFile(notExec, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(exe, Arg, notExec, "plain")
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	err = cmd.Run()
	var ee *exec.ExitError
	if !errors.As(err, &ee) || ee.ExitCode() != 127 {
		t.Fatalf("want exit 127, got %v; output %q", err, out.String())
	}
	if !strings.Contains(out.String(), "caprock: exec") {
		t.Errorf("no reason given: %q", out.String())
	}
}
