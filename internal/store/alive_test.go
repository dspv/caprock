package store

import (
	"context"
	"os"
	"os/exec"
	"runtime"
	"testing"
	"time"
)

// A session is over when its process is gone. Every previous rule was a guess
// about a person's day — twelve hours left the day's work live at midnight, one
// hour closed a session while its owner was at lunch — standing in for a fact
// about a process. These tests are about the fact.

func TestOurOwnProcessIsAlive(t *testing.T) {
	if !ProcessAlive(os.Getpid()) {
		t.Fatal("this process reports itself dead")
	}
}

func TestAnExitedProcessIsNotAlive(t *testing.T) {
	// A real process, really exited — not a pid picked out of the air, which
	// would only prove that some number is unused.
	cmd := exec.Command(sleeper(), sleeperArgs()...)
	if err := cmd.Start(); err != nil {
		t.Skipf("cannot start a helper process: %v", err)
	}
	pid := cmd.Process.Pid
	if !ProcessAlive(pid) {
		t.Fatalf("a running child (%d) reports dead", pid)
	}
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = cmd.Wait() // reap, or the pid stays a zombie and still "exists"
	if ProcessAlive(pid) {
		t.Errorf("a killed and reaped child (%d) still reports alive", pid)
	}
}

func TestAnUnknownPidIsNeverAlive(t *testing.T) {
	// 0 means "we never learned it" and 1 is init — always running, and never
	// a Claude Code session. Treating either as alive would make a session
	// whose pid is unknown immortal, which is the opposite failure from the
	// one being fixed but just as wrong.
	for _, pid := range []int{0, 1, -1} {
		if ProcessAlive(pid) {
			t.Errorf("pid %d reported alive", pid)
		}
	}
}

// A process that lives long enough to be asked about, on every OS.
//
// Not `timeout` on Windows: it reads the console to allow a keypress to cancel
// it, and under CI there is no console, so it exits immediately — which turns
// "is this running process alive" into a test of a process that already
// finished. `ping -n` to the loopback address is the portable stand-in that
// Windows scripts have used for exactly this reason for decades.
func sleeper() string {
	if runtime.GOOS == "windows" {
		return "ping"
	}
	return "sleep"
}

func sleeperArgs() []string {
	if runtime.GOOS == "windows" {
		// One ping a second, thirty of them. Long enough to outlive the test.
		return []string{"-n", "30", "127.0.0.1"}
	}
	return []string{"30"}
}

// The behaviour the whole change is for: a live process keeps its session,
// however long it has been quiet.
func TestALiveProcessKeepsItsSessionForever(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)

	cmd := exec.Command(sleeper(), sleeperArgs()...)
	if err := cmd.Start(); err != nil {
		t.Skipf("cannot start a helper process: %v", err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })

	const week = 7 * 24 * time.Hour
	longAgo := time.Now().Add(-week)
	if err := UpsertSession(ctx, s.DB(), "alive", SessionPatch{
		Cwd: "/tmp", StartedAt: longAgo.UnixMilli(), LastEventAt: longAgo.UnixMilli(),
		PID: cmd.Process.Pid,
	}); err != nil {
		t.Fatal(err)
	}

	// A sweep with a threshold that would have ended it many times over.
	ended, err := MarkEndedSessions(ctx, s.DB(), time.Now().Add(-time.Hour).UnixMilli())
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range ended {
		if id == "alive" {
			t.Fatal("a session whose process is running was ended after a week of quiet")
		}
	}
	got, err := GetSession(ctx, s.DB(), "alive")
	if err != nil {
		t.Fatal(err)
	}
	if got.Status == StatusEnded {
		t.Errorf("status = %s, want anything but ended", got.Status)
	}
}

// And the other half: a session whose process is gone ends on the next sweep,
// without waiting for any threshold at all.
func TestADeadProcessEndsItsSessionImmediately(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)

	cmd := exec.Command(sleeper(), sleeperArgs()...)
	if err := cmd.Start(); err != nil {
		t.Skipf("cannot start a helper process: %v", err)
	}
	pid := cmd.Process.Pid
	_ = cmd.Process.Kill()
	_ = cmd.Wait()

	// Busy a second ago: no staleness rule would end this.
	recent := time.Now().Add(-time.Second)
	if err := UpsertSession(ctx, s.DB(), "dead", SessionPatch{
		Cwd: "/tmp", StartedAt: recent.UnixMilli(), LastEventAt: recent.UnixMilli(), PID: pid,
	}); err != nil {
		t.Fatal(err)
	}

	ended, err := MarkEndedSessions(ctx, s.DB(), time.Now().Add(-8*time.Hour).UnixMilli())
	if err != nil {
		t.Fatal(err)
	}
	var found bool
	for _, id := range ended {
		if id == "dead" {
			found = true
		}
	}
	if !found {
		t.Error("a session whose process is gone was left open")
	}
}

// Sessions from before the shim reported a pid, and transcript-only reads, have
// nothing to ask. The staleness backstop is all they have — and it must still
// work, or those sessions become immortal.
func TestASessionWithNoPidStillFallsBackToTheClock(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)

	old := time.Now().Add(-9 * time.Hour)
	if err := UpsertSession(ctx, s.DB(), "nopid", SessionPatch{
		Cwd: "/tmp", StartedAt: old.UnixMilli(), LastEventAt: old.UnixMilli(),
	}); err != nil {
		t.Fatal(err)
	}
	fresh := time.Now().Add(-time.Minute)
	if err := UpsertSession(ctx, s.DB(), "nopid-fresh", SessionPatch{
		Cwd: "/tmp", StartedAt: fresh.UnixMilli(), LastEventAt: fresh.UnixMilli(),
	}); err != nil {
		t.Fatal(err)
	}

	ended, err := MarkEndedSessions(ctx, s.DB(), time.Now().Add(-8*time.Hour).UnixMilli())
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, id := range ended {
		got[id] = true
	}
	if !got["nopid"] {
		t.Error("a pid-less session quiet for 9h was not ended; those sessions would never close")
	}
	if got["nopid-fresh"] {
		t.Error("a pid-less session quiet for a minute was ended")
	}
}

// OpenCode sessions are read out of OpenCode's own database, not watched. They
// arrive already old — often months — and there is no process of ours behind
// them to ask about. Judging them by liveness kept 97-day-old rows permanently
// "live" and filled the Now screen with somebody's history.
func TestAnObservedAgentsSessionsAreJudgedByTheClockOnly(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)

	// A live pid deliberately attached to an opencode row: even so, age wins.
	cmd := exec.Command(sleeper(), sleeperArgs()...)
	if err := cmd.Start(); err != nil {
		t.Skipf("cannot start a helper process: %v", err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })

	old := time.Now().Add(-97 * 24 * time.Hour)
	if err := UpsertSession(ctx, s.DB(), "oc-old", SessionPatch{
		Cwd: "/tmp/oc", StartedAt: old.UnixMilli(), LastEventAt: old.UnixMilli(),
		Agent: "opencode", PID: cmd.Process.Pid,
	}); err != nil {
		t.Fatal(err)
	}
	// And a recent one, which must survive.
	fresh := time.Now().Add(-time.Minute)
	if err := UpsertSession(ctx, s.DB(), "oc-fresh", SessionPatch{
		Cwd: "/tmp/oc", StartedAt: fresh.UnixMilli(), LastEventAt: fresh.UnixMilli(),
		Agent: "opencode",
	}); err != nil {
		t.Fatal(err)
	}

	ended, err := MarkEndedSessions(ctx, s.DB(), time.Now().Add(-24*time.Hour).UnixMilli())
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, id := range ended {
		got[id] = true
	}
	if !got["oc-old"] {
		t.Error("a 97-day-old opencode session stayed open because a pid happened to be alive")
	}
	if got["oc-fresh"] {
		t.Error("a minute-old opencode session was ended")
	}
}
