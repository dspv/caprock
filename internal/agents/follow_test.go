package agents

import (
	"context"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/store"
)

// A /clear keeps the process and starts a new session id. The terminal
// Caprock spawned answers to the new id from then on — attach, input — and
// when the process exits both ids end.
func TestFollowFilesTheTerminalUnderTheClearedSession(t *testing.T) {
	m, st, _ := newMgr(t)
	defer m.Shutdown()
	ctx := context.Background()
	ended := make(chan string, 4)
	m.OnExit = func(id string, _ int) { ended <- id }
	a, err := m.Spawn(ctx, SpawnRequest{Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := m.Get("after-clear"); ok {
		t.Fatal("an unknown id resolved before any /clear")
	}
	if !m.Follow("after-clear", a.SessionID) {
		t.Fatal("Follow refused the spawn's own session")
	}
	got, ok := m.Get("after-clear")
	if !ok || got != a {
		t.Fatal("the new id does not reach the spawn's terminal")
	}
	if a.Current() != "after-clear" {
		t.Errorf("Current = %q, want the session the /clear started", a.Current())
	}
	// A second /clear chains through the first.
	if !m.Follow("second-clear", "after-clear") || a.Current() != "second-clear" {
		t.Errorf("a second /clear did not follow: current %q", a.Current())
	}
	if _, ok := m.Get(a.SessionID); !ok {
		t.Error("the spawn's own id stopped answering")
	}
	// Running is still one process, under the spawn's id.
	if r := m.OwnedRunning(); len(r) != 1 || r[0] != a.SessionID {
		t.Errorf("OwnedRunning = %v, want only the spawn", r)
	}
	if err := m.Input("second-clear", []byte("exit\n")); err != nil {
		t.Fatalf("typing through the followed id: %v", err)
	}
	seen := map[string]bool{}
	for len(seen) < 3 {
		select {
		case id := <-ended:
			seen[id] = true
		case <-time.After(5 * time.Second):
			t.Fatalf("exit told for %v only", seen)
		}
	}
	for _, id := range []string{a.SessionID, "after-clear", "second-clear"} {
		if !seen[id] {
			t.Errorf("exit not told for %s", id)
		}
		if _, ok := m.Get(id); ok {
			t.Errorf("%s still resolves after the exit", id)
		}
	}
	_ = st
}

// Nothing is filed under a session Caprock holds no terminal for, nor over
// one that has a terminal of its own (a fork runs in its own process).
func TestFollowRefusesWhatIsNotTheSameTerminal(t *testing.T) {
	m, _, _ := newMgr(t)
	if m.Follow("new", "not-ours") {
		t.Error("followed a session Caprock did not start")
	}
	m.agents["fork"] = &Agent{SessionID: "fork"}
	m.agents["orig"] = &Agent{SessionID: "orig"}
	if m.Follow("fork", "orig") {
		t.Error("a session with a terminal of its own was filed under another")
	}
	if a, _ := m.Get("fork"); a.SessionID != "fork" {
		t.Error("the fork lost its own terminal")
	}
}

// A daemon restarted after a /clear finds the newest session of the process
// from the rows, and the spawn's row is not brought back to life.
func TestFollowClearedOnReattach(t *testing.T) {
	m, st, _ := newMgr(t)
	ctx := context.Background()
	const pid = 4711
	db := st.DB()
	for _, r := range []struct {
		id, parent string
		started    int64
		status     string
	}{
		{"spawn", "", 1, store.StatusEnded},
		{"c1", "spawn", 2, store.StatusEnded},
		{"c2", "c1", 3, store.StatusActive},
	} {
		if err := store.UpsertSession(ctx, db, r.id, store.SessionPatch{Cwd: "/w", StartedAt: r.started, LastEventAt: r.started, PID: pid, ParentSession: r.parent, Status: r.status}); err != nil {
			t.Fatal(err)
		}
	}
	if err := store.MarkOwned(ctx, db, "spawn", "", "claude", pid); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE sessions SET status = 'ended' WHERE session_id = 'spawn'`); err != nil {
		t.Fatal(err)
	}
	a := &Agent{SessionID: "spawn", Command: "claude"}
	m.agents["spawn"] = a
	if got := m.followCleared(ctx, a, pid); got != "c2" {
		t.Fatalf("followCleared = %q, want c2", got)
	}
	if a.Current() != "c2" {
		t.Errorf("Current = %q, want c2", a.Current())
	}
	for _, id := range []string{"c1", "c2"} {
		if got, ok := m.Get(id); !ok || got != a {
			t.Errorf("%s does not reach the terminal", id)
		}
	}
	s, _ := store.GetSession(ctx, db, "c2")
	if !s.Owned || s.Status == store.StatusEnded {
		t.Errorf("c2 = owned %v, %s; want owned and live", s.Owned, s.Status)
	}
	s, _ = store.GetSession(ctx, db, "spawn")
	if s.Status != store.StatusEnded {
		t.Errorf("the cleared spawn's row is %s, want ended", s.Status)
	}
}
