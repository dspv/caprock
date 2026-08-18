//go:build smoke

package agents

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/ptyman"
	"github.com/dspv/caprock/internal/store"
)

// fakeClaude writes a shim named "claude" (or claude.cmd) on PATH that behaves
// like a tiny interactive REPL, so the Phase 1 spawn→stream→type→kill path is
// exercised on all three OS without the real CLI.
func fakeClaude(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if runtime.GOOS == "windows" {
		p := filepath.Join(dir, "claude.cmd")
		_ = os.WriteFile(p, []byte("@echo off\r\n(echo caprock-fake-claude ready)\r\n:loop\r\nset \"x=\"\r\nset /p x=\r\nif \"%x%\"==\"quit\" exit /b 0\r\necho you-said:%x%\r\ngoto loop\r\n"), 0o755)
		return p
	}
	p := filepath.Join(dir, "claude")
	_ = os.WriteFile(p, []byte("#!/bin/sh\necho caprock-fake-claude ready\nwhile IFS= read -r line; do\n  [ \"$line\" = quit ] && exit 0\n  echo \"you-said:$line\"\ndone\n"), 0o755)
	return p
}

func TestPhase1SpawnStreamTypeKill(t *testing.T) {
	if runtime.GOOS != "windows" {
		if _, err := exec.LookPath("sh"); err != nil {
			t.Skip("no sh")
		}
	}
	st, err := store.Open(context.Background(), ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	m := NewManager(st, t.TempDir(), fakeClaude(t), discardLogger())
	if !m.ClaudeAvailable() {
		t.Fatal("fake claude not available")
	}
	ctx := context.Background()
	a, err := m.Spawn(ctx, SpawnRequest{Cwd: t.TempDir()})
	if err != nil {
		t.Fatalf("spawn: %v", err)
	}
	sub, cancel := a.Subscribe()
	defer cancel()
	read := func(substr string) {
		t.Helper()
		var buf bytes.Buffer
		deadline := time.After(8 * time.Second)
		for !bytes.Contains(buf.Bytes(), []byte(substr)) {
			select {
			case b, ok := <-sub:
				if !ok {
					t.Fatalf("stream ended before %q: %q", substr, buf.String())
				}
				buf.Write(b)
			case <-deadline:
				t.Fatalf("timeout for %q: %q", substr, buf.String())
			}
		}
	}
	read("caprock-fake-claude ready")
	if err := m.Resize(a.SessionID, 100, 30); err != nil {
		t.Fatalf("resize: %v", err)
	}
	if err := m.Input(a.SessionID, []byte("hello\n")); err != nil {
		t.Fatalf("input: %v", err)
	}
	read("you-said:hello")
	// Kill and confirm exit is recorded.
	if err := m.Signal(a.SessionID, ptyman.SignalKill); err != nil {
		t.Fatalf("kill: %v", err)
	}
	deadline := time.After(8 * time.Second)
	for {
		if _, ok := m.Get(a.SessionID); !ok {
			break
		}
		select {
		case <-time.After(100 * time.Millisecond):
		case <-deadline:
			t.Fatal("session not removed after kill")
		}
	}
	s, _ := store.GetSession(ctx, st.DB(), a.SessionID)
	if s.Status != store.StatusEnded {
		t.Fatalf("status after kill: %s", s.Status)
	}
	m.Shutdown()
}
