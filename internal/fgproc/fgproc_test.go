package fgproc

import (
	"context"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/ptyman"
)

func TestProgName(t *testing.T) {
	for _, c := range []struct{ argv0, comm, want string }{
		{"claude", "2.1.289", "claude"},
		{"/Users/me/.local/bin/claude", "2.1.289", "claude"},
		{"-zsh", "zsh", "zsh"},
		{"", "vim", "vim"},
		{`C:\Program Files\nodejs\node.exe`, "", "node"},
		{"PING.EXE", "", "PING"},
		{"", "", Unnamed},
	} {
		if got := progName(c.argv0, c.comm); got != c.want {
			t.Errorf("progName(%q, %q) = %q, want %q", c.argv0, c.comm, got, c.want)
		}
	}
}

func TestForegroundOfNothing(t *testing.T) {
	for _, pid := range []int{-1, 0, 1} {
		if got := Foreground(pid); got != "" {
			t.Errorf("Foreground(%d) = %q, want nothing", pid, got)
		}
	}
}

// A shell under a pty names nothing at its prompt, names the job a user
// starts from it, and names nothing again once the job ends — the three
// answers a tab's close button acts on.
func TestForegroundUnderAPty(t *testing.T) {
	if runtime.GOOS != "darwin" && runtime.GOOS != "linux" {
		t.Skip("the terminal's foreground group is read on macOS and Linux")
	}
	if _, err := os.Stat("/bin/sh"); err != nil {
		t.Skip("no /bin/sh")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	s, err := ptyman.New().Spawn(ctx, ptyman.Spec{
		Command: "/bin/sh", Args: []string{"-i"}, Dir: t.TempDir(),
		Env: []string{"PATH=/usr/bin:/bin", "PS1=$ ", "ENV=", "HOME=" + t.TempDir()}, Cols: 80, Rows: 24,
	})
	if err != nil {
		t.Fatalf("spawn sh: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	go func() { _, _ = io.Copy(io.Discard, s.Output()) }()
	pid := s.PID()

	waitFor := func(want string) {
		t.Helper()
		var got string
		for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(50 * time.Millisecond) {
			if got = Foreground(pid); got == want {
				return
			}
		}
		t.Fatalf("Foreground(shell) = %q, want %q", got, want)
	}

	waitFor("")
	if _, err := s.Write([]byte("sleep 30\n")); err != nil {
		t.Fatalf("type: %v", err)
	}
	waitFor("sleep")
	// The job is the group in front; the job's process is in it, the shell is not.
	name, job := Job(pid)
	if name != "sleep" || job <= 1 {
		t.Fatalf("Job(shell) = %q, %d, want sleep and its group", name, job)
	}
	if !InJob(job, job) {
		t.Error("the job's leader is not in its own job")
	}
	if InJob(pid, job) {
		t.Error("the shell counted as part of the job in front of it")
	}
	if _, err := s.Write([]byte{0x03}); err != nil { // Ctrl-C ends the job
		t.Fatalf("interrupt: %v", err)
	}
	waitFor("")
}

// A parent pid is a stale number on Windows: csrss names as its parent the
// smss.exe that exited at boot, and a later process can draw that pid. Only a
// process started after the shell is its child — the CI flake where every
// poll answered "csrss".
func TestChildNameSkipsAnOrphanOfAReusedPid(t *testing.T) {
	const shell, start = 4242, 1000
	procs := []proc{
		{pid: 600, ppid: shell, exe: "csrss.exe", start: 10},          // older than the shell
		{pid: 4242, ppid: shell, exe: "pwsh.exe", start: 1000},        // the shell itself
		{pid: 5000, ppid: 99, exe: "vim.exe", start: 2000},            // someone else's
		{pid: 5001, ppid: shell, exe: "conhost.exe", start: 1001},     // the console host
		{pid: 5002, ppid: shell, exe: `C:\bin\PING.EXE`, start: 1500}, // the job
	}
	if got := childName(shell, start, procs); got != "PING" {
		t.Errorf("childName = %q, want PING", got)
	}
	if got := childName(shell, start, procs[:4]); got != "" {
		t.Errorf("childName without a job = %q, want nothing", got)
	}
	if got := childName(shell, start, []proc{{pid: 7, ppid: shell, exe: "same.exe", start: start}}); got != "same" {
		t.Errorf("a child started in the shell's clock tick = %q, want same", got)
	}
}

// On Windows a session's process belongs to the shell's job when the job is
// it or a parent a few levels up — node under cmd.exe under claude.cmd — and a
// "parent" younger than its child is a reused pid, not a parent.
func TestParentChain(t *testing.T) {
	procs := []proc{
		{pid: 10, ppid: 1, start: 100},  // the shell's job: cmd.exe running claude.cmd
		{pid: 11, ppid: 10, start: 110}, // node, the session's process
		{pid: 12, ppid: 11, start: 120}, // a tool it runs
		{pid: 20, ppid: 30, start: 50},  // claims a parent that started after it
		{pid: 30, ppid: 10, start: 300},
	}
	for _, c := range []struct {
		pid, job int
		want     bool
	}{
		{11, 10, true}, {12, 10, true}, {10, 10, true},
		{20, 10, false}, // through a reused pid
		{11, 12, false}, // a child is not a parent
		{99, 10, false}, // gone
	} {
		if got := parentChain(c.pid, c.job, procs); got != c.want {
			t.Errorf("parentChain(%d, %d) = %v, want %v", c.pid, c.job, got, c.want)
		}
	}
	if InJob(0, 10) || InJob(11, 1) {
		t.Error("InJob answered for an unknown pid or job")
	}
}

// On Windows there is no foreground group; the shell's child is the program.
// The test process stands in for the shell.
func TestForegroundIsAChildOnWindows(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("the child scan is the Windows path")
	}
	cmd := exec.Command("ping", "-n", "30", "127.0.0.1")
	if err := cmd.Start(); err != nil {
		t.Skipf("no ping: %v", err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	var got string
	for deadline := time.Now().Add(30 * time.Second); time.Now().Before(deadline); time.Sleep(50 * time.Millisecond) {
		if got = Foreground(os.Getpid()); strings.EqualFold(got, "ping") {
			return
		}
	}
	t.Fatalf("Foreground(test process) = %q after 30s, want ping (pid %d, test pid %d)", got, cmd.Process.Pid, os.Getpid())
}
