//go:build !windows

package ptyhost

import (
	"context"
	"errors"
	"os"
	"regexp"
	"strconv"
	"syscall"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/ptyman"
)

// alive reports whether pid is still a process (a zombie counts as gone: it
// is waiting only to be reaped).
func alive(pid int) bool {
	if err := syscall.Kill(pid, 0); errors.Is(err, syscall.ESRCH) {
		return false
	}
	return true
}

// A terminal's holder stops on SIGTERM. Its child is an interactive shell,
// which ignores SIGTERM, so passing SIGTERM on and waiting for the child left
// the holder running for good: on the measuring stand (2026-10-19) every
// shell holder needed SIGKILL.
func TestSIGTERMStopsAShellHolder(t *testing.T) {
	sh := "/bin/sh"
	if _, err := os.Stat(sh); err != nil {
		t.Skip("no /bin/sh")
	}
	// A race build sleeps a second on its way out (atexit_sleep_ms), which
	// is the race detector's, not the holder's.
	t.Setenv("GORACE", "atexit_sleep_ms=0")
	data := t.TempDir()
	env := []string{"PATH=/usr/bin:/bin", "HOME=" + t.TempDir(), "TERM=xterm-256color", "PS1=$ ", "ENV=/dev/null"}
	spec := ptyman.Spec{ID: "s-shell", Command: sh, Args: []string{"-i"}, Dir: t.TempDir(), Env: env, Cols: 100, Rows: 30}
	s, err := newManager(t, data).Spawn(context.Background(), spec)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	shellPID := s.PID()
	out := readAll(s.Output())
	// A job of the shell's, so the test sees the hangup reach it too.
	if _, err := s.Write([]byte("sleep 600 & echo job=$!\r")); err != nil {
		t.Fatal(err)
	}
	out.waitFor(t, "job=")
	var jobPID int
	deadline := time.Now().Add(5 * time.Second)
	for jobPID == 0 && time.Now().Before(deadline) {
		out.mu.Lock()
		m := regexp.MustCompile(`job=(\d+)`).FindStringSubmatch(out.buf.String())
		out.mu.Unlock()
		if m != nil {
			jobPID, _ = strconv.Atoi(m[1])
		} else {
			time.Sleep(20 * time.Millisecond)
		}
	}
	if jobPID == 0 {
		t.Fatal("the shell did not report its job")
	}
	defer func() { _ = syscall.Kill(jobPID, syscall.SIGKILL) }()

	recs, _, err := readRecords(Dir(data))
	if err != nil || len(recs) != 1 {
		t.Fatalf("registry: %v, %d entries", err, len(recs))
	}
	hostPID := recs[0].HostPID
	start := time.Now()
	if err := syscall.Kill(hostPID, syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	for alive(hostPID) || alive(shellPID) {
		if time.Since(start) > 1500*time.Millisecond {
			t.Fatalf("after SIGTERM: holder alive %v, shell alive %v", alive(hostPID), alive(shellPID))
		}
		time.Sleep(10 * time.Millisecond)
	}
	took := time.Since(start)
	t.Logf("holder and shell gone %v after SIGTERM", took)
	if took > time.Second {
		t.Fatalf("the holder took %v to stop; want about a second at most", took)
	}
	// The shell's job is the shell's to stop, through the hangup: the holder
	// signals only its own child and that child's group. Where the job runs
	// in a group of its own and the shell does not pass the hangup on (seen
	// on the CI runners, 2026-10-19), it outlives the holder; that is logged,
	// not failed.
	for alive(jobPID) && time.Since(start) < 3*time.Second {
		time.Sleep(10 * time.Millisecond)
	}
	if alive(jobPID) {
		t.Logf("the shell's job %d outlived the holder", jobPID)
	}
	waitGone(t, recordPath(Dir(data), "s-shell"))
}
