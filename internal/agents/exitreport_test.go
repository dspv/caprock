package agents

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/store"
)

// spawnAndPrint starts a fake session, puts out on its screen and waits
// until the manager has it.
func spawnAndPrint(t *testing.T, m *Manager, f *fakePTY, req SpawnRequest, out string) *Agent {
	t.Helper()
	a, err := m.Spawn(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	if out != "" {
		f.session.out <- []byte(out)
		deadline := time.Now().Add(3 * time.Second)
		for !bytes.Contains(a.Snapshot(), []byte(out[len(out)-3:])) {
			if time.Now().After(deadline) {
				t.Fatal("the output never reached the ring")
			}
			time.Sleep(5 * time.Millisecond)
		}
	}
	return a
}

func waitExit(t *testing.T, a *Agent) {
	t.Helper()
	select {
	case <-a.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("no exit")
	}
}

// A program that exits a moment after it started — `claude --resume` that
// cannot find the conversation — leaves its code, its last lines and its
// launch, in memory and in the store, and a WARN line in the log with them.
func TestAnEarlyExitKeepsWhatItPrinted(t *testing.T) {
	m, st, f := newMgr(t)
	defer m.Shutdown()
	var logged bytes.Buffer
	m.log = slog.New(slog.NewTextHandler(&logged, &slog.HandlerOptions{Level: slog.LevelInfo}))
	cwd := t.TempDir()
	a := spawnAndPrint(t, m, f, SpawnRequest{Cwd: cwd, Resume: "11111111-2222-3333-4444-555555555555", Fork: true, PermissionMode: "auto", Prompt: "a private first message"},
		"\x1b[2J\x1b[H\x1b[31mNo conversation found with session ID: 11111111-2222-3333-4444-555555555555\x1b[0m\r\n\r\n")
	f.session.finish(7)
	waitExit(t, a)

	rep, ok := m.Exit(a.SessionID)
	if !ok {
		t.Fatal("no exit report")
	}
	if rep.Code != 7 || !rep.Early || rep.Agent != AgentClaude {
		t.Fatalf("report %+v", rep)
	}
	if rep.Tail != "No conversation found with session ID: 11111111-2222-3333-4444-555555555555" {
		t.Fatalf("tail %q", rep.Tail)
	}
	if rep.Retry == nil || rep.Retry.Resume != "11111111-2222-3333-4444-555555555555" || !rep.Retry.Fork || rep.Retry.Cwd != cwd || rep.Retry.PermissionMode != "auto" {
		t.Fatalf("retry %+v", rep.Retry)
	}
	stored, ok, err := store.GetExit(context.Background(), st.DB(), a.SessionID)
	if err != nil || !ok || stored.Code != 7 || !stored.Early || stored.Tail != rep.Tail {
		t.Fatalf("stored %+v %v %v", stored, ok, err)
	}
	log := logged.String()
	if !strings.Contains(log, "level=WARN") || !strings.Contains(log, "exited at once") || !strings.Contains(log, "No conversation found") || !strings.Contains(log, "--fork-session") {
		t.Fatalf("log:\n%s", log)
	}
	if strings.Contains(log, "a private first message") {
		t.Fatalf("the first message reached the log:\n%s", log)
	}

	// A daemon that no longer remembers it reads it from the store.
	m.mu.Lock()
	m.exits = nil
	m.mu.Unlock()
	if back, ok := m.Exit(a.SessionID); !ok || back.Tail != rep.Tail || !back.Early || back.Retry != nil {
		t.Fatalf("from the store: %+v %v", back, ok)
	}
}

// Typed into, or stopped by Caprock, a session that ends soon after its
// start did not fail to start: its exit is kept, but not as early.
func TestAnExitAfterInputOrAStopIsNotEarly(t *testing.T) {
	m, _, f := newMgr(t)
	defer m.Shutdown()
	a := spawnAndPrint(t, m, f, SpawnRequest{Cwd: t.TempDir()}, "> ready")
	if err := m.Input(a.SessionID, []byte("exit\n")); err != nil {
		t.Fatal(err)
	}
	waitExit(t, a)
	if rep, ok := m.Exit(a.SessionID); !ok || rep.Early || rep.Tail != "> ready" {
		t.Fatalf("typed: %+v %v", rep, ok)
	}

	m2, _, f2 := newMgr(t)
	defer m2.Shutdown()
	b := spawnAndPrint(t, m2, f2, SpawnRequest{Cwd: t.TempDir()}, "")
	if err := m2.End(b.SessionID); err != nil {
		t.Fatal(err)
	}
	waitExit(t, b)
	if rep, ok := m2.Exit(b.SessionID); !ok || rep.Early {
		t.Fatalf("ended: %+v %v", rep, ok)
	}
}

func TestEarlyExitWindow(t *testing.T) {
	m, _, f := newMgr(t)
	defer m.Shutdown()
	a := spawnAndPrint(t, m, f, SpawnRequest{Cwd: t.TempDir()}, "")
	// As if it had run past the window.
	a.StartedAt = time.Now().Add(-EarlyExit - time.Second)
	f.session.finish(7)
	waitExit(t, a)
	if rep, _ := m.Exit(a.SessionID); rep.Early || rep.RanMs < EarlyExit.Milliseconds() {
		t.Fatalf("report %+v", rep)
	}
}

func TestScreenTail(t *testing.T) {
	var b strings.Builder
	for i := 0; i < 100; i++ {
		b.WriteString("line ")
		b.WriteString(strings.Repeat("x", i%7))
		b.WriteString("\r\n")
	}
	b.WriteString("\x1b[1mError:\x1b[0m the last\x1b[20Gword\r\n\r\n\r\n")
	got := screenTail([]byte(b.String()), 80)
	lines := strings.Split(got, "\n")
	if len(lines) != exitTailLines || lines[len(lines)-1] != "Error: the last    word" {
		t.Fatalf("%d lines, last %q", len(lines), lines[len(lines)-1])
	}
	big := strings.Repeat(strings.Repeat("é", 150)+"\r\n", 60)
	if got := screenTail([]byte(big), 200); len(got) > exitTailMax || !strings.HasPrefix(got, "é") {
		t.Fatalf("capped tail %d bytes, starts %q", len(got), got[:4])
	}
}

func TestRedactArgs(t *testing.T) {
	got := redactArgs("/usr/local/bin/claude", []string{
		"--resume", "11111111-2222-3333-4444-555555555555", "--fork-session", "--session-id", "aaaa", "--permission-mode", "auto",
		"--add-dir=/Users/u/My Project", "--append-system-prompt", "Project rules: never push to main.", "ANTHROPIC_API_KEY=sk-ant-x", "fix the login page please",
	})
	want := "/usr/local/bin/claude --resume 11111111-2222-3333-4444-555555555555 --fork-session --session-id aaaa --permission-mode auto --add-dir=/Users/u/My Project --append-system-prompt [34 chars] [redacted] [25 chars]"
	if got != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
}
