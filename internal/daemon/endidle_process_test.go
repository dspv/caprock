package daemon

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/store"
)

// The idle end on real processes, a fake claude in a real terminal, with the
// clock moved 13 hours on: the untabbed session's process is asked to end
// and exits, its row ended and marked as ended for idling; the one with a
// tab still runs.
func TestEndIdleEndsARealUntabbedProcess(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the fake claude here is a POSIX shell script; the logic is covered on every OS by the other EndIdle tests")
	}
	dir := t.TempDir()
	fake := filepath.Join(dir, "claude")
	if err := os.WriteFile(fake, []byte("#!/bin/sh\necho caprock-fake-claude ready\nwhile IFS= read -r line; do echo \"you-said:$line\"; done\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	st, err := store.Open(context.Background(), ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	m := agents.NewManager(st, filepath.Join(dir, "data"), fake, log)
	t.Cleanup(m.Shutdown)
	d := &Daemon{store: st, bus: bus.New(), log: log, mgr: m}
	q := newMsgQueue(d)
	ctx := context.Background()
	idle, err := m.Spawn(ctx, agents.SpawnRequest{Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	tabbed, err := m.Spawn(ctx, agents.SpawnRequest{Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	e := newEndIdle(d, q, newOpenTabs(""))
	e.window = func() time.Duration { return 12 * time.Hour }
	e.worker = func(string) bool { return false }
	e.since = time.Now().Add(-time.Hour)
	e.now = func() time.Time { return time.Now().Add(13 * time.Hour) }
	if err := e.tabs.report("app", []string{tabbed.SessionID}); err != nil {
		t.Fatal(err)
	}
	e.sweep(ctx)
	select {
	case <-idle.Done():
	case <-time.After(15 * time.Second):
		t.Fatal("the idle session's process did not end")
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		s, err := store.GetSession(ctx, st.DB(), idle.SessionID)
		if err != nil {
			t.Fatal(err)
		}
		if s.Status == store.StatusEnded && s.IdleEndedAt > 0 && s.IdleEndedAfter == (12*time.Hour).Milliseconds() {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("row not ended and marked: %+v", s)
		}
		time.Sleep(50 * time.Millisecond)
	}
	if _, ok := m.Get(tabbed.SessionID); !ok {
		t.Fatal("the session with a tab was ended")
	}
	select {
	case <-tabbed.Done():
		t.Fatal("the session with a tab exited")
	default:
	}
}
