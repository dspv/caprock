// Rule 7 — "we never signal or type into a process we did not start" — is
// enforced here, at the thing that holds the process handles, rather than by
// whoever happens to be calling. The daily spend cap is the caller that matters
// today: it pauses expensive sessions, and it must be structurally unable to
// pause one that lives in somebody else's terminal, however much that one is
// costing. These tests hold that line from the caller's side.
package agents

import (
	"context"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/ptyman"
)

// PauseOwned reports "did not pause" for a session Caprock did not spawn, and
// reports it without an error — a spend cap sweeping every expensive session
// must skip the ones it does not own quietly, not log a failure per session per
// tick. The distinction between (false, nil) and (false, err) is what tells the
// cap "not mine" from "mine and broken".
func TestPauseOwnedRefusesASessionCaprockDidNotStart(t *testing.T) {
	m, _, _ := newMgr(t)
	defer m.Shutdown()

	paused, err := m.PauseOwned("a-session-from-someones-terminal")
	if err != nil {
		t.Errorf("PauseOwned on a foreign session returned %v; want a quiet no — the cap sweeps these every tick", err)
	}
	if paused {
		t.Fatal("PauseOwned reported it paused a session Caprock never started; Rule 7 is broken")
	}
}

// The session Caprock did start is pausable, and the pause reaches the process
// rather than only being recorded. A cap that reports success without stopping
// anything is the worst of both: the user believes they are protected and the
// bill keeps climbing.
func TestPauseOwnedActuallyPausesTheProcess(t *testing.T) {
	m, _, f := newMgr(t)
	defer m.Shutdown()
	a, err := m.Spawn(context.Background(), SpawnRequest{Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}

	paused, err := m.PauseOwned(a.SessionID)
	if err != nil {
		t.Fatalf("PauseOwned: %v", err)
	}
	if !paused {
		t.Fatal("PauseOwned reported no for a session it spawned")
	}
	if !f.session.Paused() {
		t.Error("the pause never reached the process; the cap would report a saving it did not make")
	}
	if !a.Paused() {
		t.Error("Agent.Paused disagrees with the process; the UI would show a running session as stopped or vice versa")
	}
}

// OwnedRunning is the list the spend cap iterates. It must contain exactly the
// live sessions this manager spawned — a session that has exited must drop out,
// or the cap keeps trying to pause a process that is gone, and a foreign
// session must never appear in it at all.
func TestOwnedRunningListsOnlyLiveOwnedSessions(t *testing.T) {
	m, _, _ := newMgr(t)
	defer m.Shutdown()

	if got := m.OwnedRunning(); len(got) != 0 {
		t.Fatalf("a fresh manager owns %v; want nothing", got)
	}

	// OnExit is captured when the agent is built, so it is set before the spawn.
	exited := make(chan struct{})
	m.OnExit = func(string, int) { close(exited) }
	a, err := m.Spawn(context.Background(), SpawnRequest{Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	got := m.OwnedRunning()
	if len(got) != 1 || got[0] != a.SessionID {
		t.Fatalf("OwnedRunning = %v; want just %q", got, a.SessionID)
	}

	// Ending the session must take it off the list. The fake ends on "exit".
	if err := m.Input(a.SessionID, []byte("exit\n")); err != nil {
		t.Fatal(err)
	}
	select {
	case <-exited:
	case <-time.After(5 * time.Second):
		t.Fatal("the session never exited")
	}
	if got := m.OwnedRunning(); len(got) != 0 {
		t.Errorf("OwnedRunning = %v after the session exited; the cap would keep signalling a dead process", got)
	}
	// And a dead session is no longer pausable, for the same reason.
	if paused, _ := m.PauseOwned(a.SessionID); paused {
		t.Error("PauseOwned claimed to pause an exited session")
	}
}

// Resume is the counterpart: an owned session that was paused has to come back.
// A cap that can only stop things is a cap nobody turns on.
func TestAPausedSessionCanBeResumed(t *testing.T) {
	m, _, f := newMgr(t)
	defer m.Shutdown()
	a, err := m.Spawn(context.Background(), SpawnRequest{Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.PauseOwned(a.SessionID); err != nil {
		t.Fatal(err)
	}
	if err := m.Signal(a.SessionID, ptyman.SignalResume); err != nil {
		t.Fatalf("Signal(resume): %v", err)
	}
	if f.session.Paused() {
		t.Error("the session is still paused after a resume; the user's work stays frozen until a restart")
	}
}

// The terminal's scrollback. A browser tab opened onto a session that has been
// running for ten minutes must see what happened, not an empty screen — the
// snapshot is the only source for output that arrived before the socket did.
func TestSnapshotGivesALateTerminalTheScrollback(t *testing.T) {
	m, _, f := newMgr(t)
	defer m.Shutdown()
	a, err := m.Spawn(context.Background(), SpawnRequest{Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}

	// Output that arrives before anybody is watching.
	f.session.out <- []byte("compiling...\n")
	f.session.out <- []byte("done\n")

	if err := waitFor(func() bool { return string(a.Snapshot()) == "compiling...\ndone\n" }); err != nil {
		t.Fatalf("snapshot = %q; want the output that arrived before the terminal connected", a.Snapshot())
	}

	// A subscriber joining now gets everything from here on, and the snapshot
	// it already has covers the rest — the two together are the whole stream.
	ch, cancel := a.Subscribe()
	defer cancel()
	f.session.out <- []byte("next\n")
	select {
	case chunk := <-ch:
		if string(chunk) != "next\n" {
			t.Errorf("subscriber got %q; want the chunk written after it joined", chunk)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("a subscribed terminal received nothing")
	}
}

// Snapshot must not hand out the buffer the pump is still writing into.
// Returning the live slice let a caller see it mutate underneath them, and
// under -race it is a data race in the API goroutine that serves the terminal.
func TestSnapshotIsACopy(t *testing.T) {
	m, _, f := newMgr(t)
	defer m.Shutdown()
	a, err := m.Spawn(context.Background(), SpawnRequest{Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	f.session.out <- []byte("first")
	if err := waitFor(func() bool { return string(a.Snapshot()) == "first" }); err != nil {
		t.Fatal(err)
	}

	snap := a.Snapshot()
	snap[0] = 'X' // a caller scribbling on what it was given

	if got := string(a.Snapshot()); got != "first" {
		t.Errorf("snapshot = %q after a caller mutated an earlier one; the ring handed out its own buffer", got)
	}
}

// Subscribing to a session that has already exited must close the channel
// rather than hang. The terminal opens on a session row the user clicked, and
// the process may have ended between the click and the socket — a reader
// blocked forever on a dead session is a tab that never renders.
func TestSubscribingToADeadSessionClosesImmediately(t *testing.T) {
	m, _, _ := newMgr(t)
	defer m.Shutdown()
	// OnExit is captured when the agent is built, so it is set before the spawn.
	exited := make(chan struct{})
	m.OnExit = func(string, int) { close(exited) }
	a, err := m.Spawn(context.Background(), SpawnRequest{Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	if err := m.Input(a.SessionID, []byte("exit\n")); err != nil {
		t.Fatal(err)
	}
	select {
	case <-exited:
	case <-time.After(5 * time.Second):
		t.Fatal("the session never exited")
	}

	ch, cancel := a.Subscribe()
	defer cancel()
	select {
	case _, open := <-ch:
		if open {
			t.Error("an exited session delivered output to a new subscriber")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Subscribe on an exited session never closed its channel; the terminal tab would hang")
	}

	if code, done := a.Exited(); !done || code != 7 {
		t.Errorf("Exited() = %d, %v; want the recorded exit code 7", code, done)
	}
}

// A subscriber that never reads must not stall the session.
//
// The pump drops into a full subscriber rather than blocking, so one browser
// tab that stopped reading — closed laptop, sleeping phone — cannot wedge the
// terminal for everyone else, or for the agent writing into it.
//
// What is asserted is that output *keeps arriving* at a healthy reader while a
// stalled one sits there full, and that the writer finishes. Not how many
// chunks arrive: the buffer is deliberately lossy, so a reader that falls
// behind legitimately misses some. An earlier version of this test demanded
// 300 of 400 and passed on a fast machine while failing in CI, which is the
// test asserting a promise the code never made.
func TestASlowSubscriberDoesNotStallTheSession(t *testing.T) {
	m, _, f := newMgr(t)
	a, err := m.Spawn(context.Background(), SpawnRequest{Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}

	// One subscriber that never reads, one that does.
	_, cancelStalled := a.Subscribe()
	defer cancelStalled()
	live, cancelLive := a.Subscribe()
	defer cancelLive()

	// Well past the 256-slot subscriber buffer, so the stalled one is
	// definitely full and the pump is definitely dropping into it.
	written := make(chan struct{})
	go func() {
		defer close(written)
		for i := 0; i < 400; i++ {
			f.session.out <- []byte("x")
		}
	}()
	t.Cleanup(func() { <-written; m.Shutdown() })

	// The writer must finish. If a full subscriber blocked the pump, the
	// fake's output channel would back up and this would never close.
	select {
	case <-written:
	case <-time.After(10 * time.Second):
		t.Fatal("the writer never finished — a stalled subscriber blocked the session")
	}

	// And the healthy subscriber must still be receiving.
	select {
	case _, ok := <-live:
		if !ok {
			t.Fatal("the healthy subscriber's channel was closed")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the healthy subscriber received nothing while another was stalled")
	}
}

// Cancelling a subscription must close the channel and must be safe to call
// twice — the API's terminal handler defers it, and an error path can reach the
// same defer after an explicit cancel. A second close would panic and take the
// daemon down.
func TestCancellingASubscriptionTwiceIsSafe(t *testing.T) {
	m, _, _ := newMgr(t)
	defer m.Shutdown()
	a, err := m.Spawn(context.Background(), SpawnRequest{Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	ch, cancel := a.Subscribe()
	cancel()
	select {
	case _, open := <-ch:
		if open {
			t.Error("a cancelled subscription is still delivering output")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("cancel did not close the channel")
	}
	cancel() // must not panic
}

// waitFor polls a condition to a deadline. The pump runs on its own goroutine,
// so output arrives when it arrives: a fixed wait is either flaky on a loaded
// CI box or slow on every other run.
func waitFor(cond func() bool) error {
	deadline := time.After(5 * time.Second)
	tick := time.NewTicker(time.Millisecond)
	defer tick.Stop()
	for {
		if cond() {
			return nil
		}
		select {
		case <-deadline:
			return errTimeout
		case <-tick.C:
		}
	}
}

type timeoutError struct{}

func (timeoutError) Error() string { return "condition was not met within the deadline" }

var errTimeout = timeoutError{}
