package agents

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/ptyman"
	"github.com/dspv/caprock/internal/store"
)

// fakeManager spawns /bin/sh (or cmd.exe) instead of claude, so tests need no
// real claude binary. It records the args the "claude" would have received.
type fakePTY struct{ lastSpec ptyman.Spec }

func (f *fakePTY) Spawn(ctx context.Context, spec ptyman.Spec) (ptyman.Session, error) {
	f.lastSpec = spec
	// Echo the args back so the test can assert --session-id was passed, then read a line, then exit.
	var real ptyman.Spec
	if runtime.GOOS == "windows" {
		// Print the args then exit 7 on its own — ConPTY stdin round-trips are covered
		// by the -tags smoke Phase 1 test; here we only need spawn + exit recording.
		sh := lookOr("powershell.exe", `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`)
		real = ptyman.Spec{Command: sh, Args: []string{"-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Milliseconds 200; exit 7"}, Dir: spec.Dir}
	} else {
		real = ptyman.Spec{Command: "/bin/sh", Args: []string{"-c", "echo args:" + join(spec.Args) + "; read x; echo got:$x; exit 7"}, Dir: spec.Dir}
	}
	return ptyman.New().Spawn(ctx, real)
}

func lookOr(name, fallback string) string {
	if p, err := exec.LookPath(name); err == nil {
		return p
	}
	return fallback
}

func newMgr(t *testing.T) (*Manager, *store.Store, *fakePTY) {
	t.Helper()
	st, err := store.Open(context.Background(), ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	f := &fakePTY{}
	m := &Manager{pty: f, store: st, log: nil, dataDir: t.TempDir(), claude: "claude", agents: map[string]*Agent{}, NewSessionID: func() string { return "fixed-session-id" }}
	m.log = discardLogger()
	return m, st, f
}

func TestSpawnForcesSessionIDAndRecordsExit(t *testing.T) {
	if runtime.GOOS != "windows" {
		if _, err := exec.LookPath("sh"); err != nil {
			t.Skip("no sh")
		}
	}
	m, st, f := newMgr(t)
	defer m.Shutdown()
	ctx := context.Background()
	exited := make(chan int, 1)
	m.OnExit = func(_ string, code int) { exited <- code }
	a, err := m.Spawn(ctx, SpawnRequest{Cwd: t.TempDir(), Model: "claude-opus-5"})
	if err != nil {
		t.Fatal(err)
	}
	if a.SessionID != "fixed-session-id" {
		t.Fatalf("session id %s", a.SessionID)
	}
	// Ownership persisted.
	s, _ := store.GetSession(ctx, st.DB(), "fixed-session-id")
	if !s.Owned || s.PID == 0 {
		t.Fatalf("not owned: %+v", s)
	}
	// The manager forces --session-id and passes --model (asserted from the exact
	// argv the PTY was asked to spawn — deterministic, unlike scraping PTY output).
	gotArgs := join(f.lastSpec.Args)
	if !strings.Contains(gotArgs, "--session-id fixed-session-id") || !strings.Contains(gotArgs, "--model claude-opus-5") {
		t.Fatalf("spawn args missing: %q", gotArgs)
	}
	// Drain output so the pump never blocks while we drive the session.
	sub, cancel := a.Subscribe()
	defer cancel()
	go func() {
		for range sub {
		}
	}()
	// On POSIX the fake reads a line and echoes it; type it. On Windows the fake
	// exits on its own (ConPTY stdin round-trips are covered by the smoke test).
	if runtime.GOOS != "windows" {
		if err := m.Input("fixed-session-id", []byte("hi\n")); err != nil {
			t.Fatal(err)
		}
	}
	select {
	case code := <-exited:
		if code != 7 {
			t.Fatalf("exit code %d", code)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("did not exit")
	}
	// Exit recorded; no longer listed.
	s, _ = store.GetSession(ctx, st.DB(), "fixed-session-id")
	if s.Status != store.StatusEnded || s.ExitCode == nil || *s.ExitCode != 7 {
		t.Fatalf("exit not recorded: %+v", s)
	}
	if _, ok := m.Get("fixed-session-id"); ok {
		t.Fatal("still listed after exit")
	}
	// Control on an unknown/observe-only session is refused.
	if err := m.Input("external", []byte("x")); err == nil {
		t.Fatal("wrote into a non-owned session")
	}
}

func TestSpawnRejectsBadCwd(t *testing.T) {
	m, _, _ := newMgr(t)
	if _, err := m.Spawn(context.Background(), SpawnRequest{Cwd: filepath.Join(t.TempDir(), "nope")}); err == nil {
		t.Fatal("accepted missing cwd")
	}
}

func TestRingBuffer(t *testing.T) {
	r := newRing(8)
	r.write([]byte("abcd"))
	r.write([]byte("efgh"))
	r.write([]byte("ij")) // overflow, drops "ab"
	if got := string(r.snapshot()); got != "cdefghij" {
		t.Fatalf("ring: %q", got)
	}
	r.write([]byte("0123456789")) // larger than ring
	if got := string(r.snapshot()); got != "23456789" {
		t.Fatalf("ring big: %q", got)
	}
}

func TestWorktreeCreation(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	dir := t.TempDir()
	run := func(a ...string) {
		c := exec.Command("git", append([]string{"-C", dir}, a...)...)
		c.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		if out, err := c.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", a, err, out)
		}
	}
	run("init", "-q")
	_ = os.WriteFile(filepath.Join(dir, "f"), []byte("x"), 0o600)
	run("add", "f")
	run("commit", "-q", "-m", "init")
	wt, err := createWorktree(context.Background(), dir, "feature-x")
	if err != nil {
		t.Fatal(err)
	}
	if fi, err := os.Stat(wt); err != nil || !fi.IsDir() {
		t.Fatalf("worktree not created: %v", err)
	}
	if _, err := createWorktree(context.Background(), dir, "bad/name"); err == nil {
		t.Fatal("accepted path separator in name")
	}
}
