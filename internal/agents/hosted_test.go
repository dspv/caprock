// A session in a pty-host outlives the daemon (ADR-033). On the manager's side
// that is two promises: shutting down lets such a session go without ending
// it or recording an exit, and continuing a session whose terminal an older
// daemon lost stops only a process Caprock itself started.
package agents

import (
	"context"
	"io"
	"os/exec"
	"runtime"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/ptyman"
	"github.com/dspv/caprock/internal/store"
)

// detachable is a fake hosted session: Detach ends the daemon's view of it
// with ErrDetached and leaves the "process" running.
type detachable struct {
	*fakeSession
	detached atomic.Bool
	gone     chan struct{}
}

func (d *detachable) Detach() error {
	if d.detached.CompareAndSwap(false, true) {
		close(d.gone)
	}
	return nil
}

func (d *detachable) Wait() error {
	select {
	case <-d.gone:
		return ptyman.ErrDetached
	case <-d.done:
		return d.fakeSession.Wait()
	}
}

func (d *detachable) Output() io.Reader { return &chanReader{ch: d.out, done: d.gone} }

type detachablePTY struct{ last *detachable }

func (f *detachablePTY) Spawn(_ context.Context, spec ptyman.Spec) (ptyman.Session, error) {
	fs := &fakeSession{pid: 5151, out: make(chan []byte, 16), done: make(chan struct{}), input: make(chan []byte, 16)}
	f.last = &detachable{fakeSession: fs, gone: make(chan struct{})}
	return f.last, nil
}

func TestShutdownLeavesHostedSessionsRunning(t *testing.T) {
	m, st, _ := newMgr(t)
	f := &detachablePTY{}
	m.pty = f
	exited := make(chan struct{}, 1)
	m.OnExit = func(string, int) { exited <- struct{}{} }
	a, err := m.Spawn(context.Background(), SpawnRequest{Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	m.Shutdown()
	if !f.last.detached.Load() {
		t.Fatal("shutdown did not detach a hosted session")
	}
	if f.last.termed.Load() || f.last.exitCode() != 0 {
		t.Fatal("shutdown signalled a session that lives in a pty-host; an upgrade would end it")
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		if _, held := m.Get(a.SessionID); !held {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("a detached session is still held")
		}
		time.Sleep(10 * time.Millisecond)
	}
	select {
	case <-exited:
		t.Fatal("a detach was reported as an exit")
	case <-time.After(100 * time.Millisecond):
	}
	s, err := store.GetSession(context.Background(), st.DB(), a.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	if s.Status == store.StatusEnded || s.PID != 5151 {
		t.Fatalf("after a detach the row says status=%s pid=%d; the session is still running", s.Status, s.PID)
	}
}

// The backend is told the session id, which names the pty-host's registry
// entry the next daemon finds it by.
func TestSpawnNamesTheSessionToTheBackend(t *testing.T) {
	m, _, f := newMgr(t)
	defer m.Shutdown()
	if _, err := m.Spawn(context.Background(), SpawnRequest{Cwd: t.TempDir()}); err != nil {
		t.Fatal(err)
	}
	if f.lastSpec.ID != "fixed-session-id" {
		t.Fatalf("spec.ID = %q; want the session id", f.lastSpec.ID)
	}
	// The agent travels with the session, so the daemon that reattaches it
	// knows a Codex or OpenCode session from a Claude Code one.
	if f.lastSpec.Meta[metaKind] != AgentClaude {
		t.Fatalf("spec.Meta = %v; want the agent recorded", f.lastSpec.Meta)
	}
}

// sleeper starts a process that would outlive the test, standing in for a
// terminal-less session an older daemon left behind.
func sleeper(t *testing.T) *exec.Cmd {
	t.Helper()
	var c *exec.Cmd
	if runtime.GOOS == "windows" {
		c = exec.Command("ping", "-n", "60", "127.0.0.1")
	} else {
		c = exec.Command("sleep", "60")
	}
	if err := c.Start(); err != nil {
		t.Skipf("cannot start a sleeper: %v", err)
	}
	exited := make(chan struct{})
	go func() { _ = c.Wait(); close(exited) }()
	t.Cleanup(func() {
		_ = c.Process.Kill()
		<-exited
	})
	return c
}

func seedSession(t *testing.T, st *store.Store, id string, owned bool, pid int) {
	t.Helper()
	ctx := context.Background()
	err := st.WithTx(ctx, func(q store.Querier) error {
		if err := store.UpsertSession(ctx, q, id, store.SessionPatch{Cwd: t.TempDir(), Agent: "claude"}); err != nil {
			return err
		}
		if owned {
			return store.MarkOwned(ctx, q, id, "", "claude", pid)
		}
		_, err := q.ExecContext(ctx, `UPDATE sessions SET pid = ? WHERE session_id = ?`, pid, id)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
}

func alive(pid int) bool { return store.ProcessAlive(pid) }

// Continuing an owned session whose process lost its terminal stops that
// process first, so two processes never write one transcript.
func TestContinueStopsTheLeftoverOfAnOwnedSession(t *testing.T) {
	m, st, _ := newMgr(t)
	defer m.Shutdown()
	p := sleeper(t)
	seedSession(t, st, "left-behind", true, p.Process.Pid)
	if _, err := m.Spawn(context.Background(), SpawnRequest{Cwd: t.TempDir(), Resume: "left-behind"}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for alive(p.Process.Pid) {
		if time.Now().After(deadline) {
			t.Fatal("the leftover process of an owned session is still running after continuing it")
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// Rule 7: a session somebody started in their own terminal is never signalled,
// whatever the request says — continuing it under its own id is the user's
// call, and the process is not Caprock's.
func TestContinueNeverStopsASessionCaprockDidNotStart(t *testing.T) {
	m, st, _ := newMgr(t)
	defer m.Shutdown()
	p := sleeper(t)
	seedSession(t, st, "theirs", false, p.Process.Pid)
	if _, err := m.Spawn(context.Background(), SpawnRequest{Cwd: t.TempDir(), Resume: "theirs"}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(300 * time.Millisecond)
	if !alive(p.Process.Pid) {
		t.Fatal("Caprock stopped a process it did not start (rule 7)")
	}
}

// A fork leaves the original alone by definition.
func TestForkNeverStopsTheOriginal(t *testing.T) {
	m, st, _ := newMgr(t)
	defer m.Shutdown()
	p := sleeper(t)
	seedSession(t, st, "original", true, p.Process.Pid)
	if _, err := m.Spawn(context.Background(), SpawnRequest{Cwd: t.TempDir(), Resume: "original", Fork: true}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(300 * time.Millisecond)
	if !alive(p.Process.Pid) {
		t.Fatal("a fork stopped the session it branched from")
	}
}
