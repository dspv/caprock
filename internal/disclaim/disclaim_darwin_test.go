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
	"time"
)

// The read-only responsibility lookup the pty-host and its tests rely on: a
// program started through the trampoline answers for itself, one started
// plainly does not.
func TestResponsibleForTellsADisclaimedProgramFromAPlainOne(t *testing.T) {
	if ResponsibleFor(os.Getpid()) == 0 {
		t.Fatal("responsibility_get_pid_responsible_for_pid not found; every macOS since 10.14 has it")
	}
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	start := func(name string, args []string) *exec.Cmd {
		t.Helper()
		cmd := exec.Command(name, args...)
		in, err := cmd.StdinPipe()
		if err != nil {
			t.Fatal(err)
		}
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = in.Close(); _ = cmd.Wait() })
		return cmd
	}
	// cat waits on its stdin, so it is still running when asked about.
	plain := start("/bin/cat", nil)
	defer EnableWith(exe)()
	name, args := Wrap("/bin/cat", nil)
	disclaimed := start(name, args)
	waitResponsible(t, disclaimed.Process.Pid, disclaimed.Process.Pid)
	if got := ResponsibleFor(plain.Process.Pid); got == plain.Process.Pid {
		t.Errorf("a plainly started program answers for itself (%d)", got)
	}
}

// waitResponsible waits for pid to be answered for by want: until the
// trampoline has become its program, its parent's responsible process
// answers for it.
func waitResponsible(t *testing.T, pid, want int) {
	t.Helper()
	var got int
	for range 300 {
		if got = ResponsibleFor(pid); got == want {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("pid %d: responsible %d, want %d", pid, got, want)
}

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
