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

// fakeManager spawns /bin/sh (or cmd.exe) instead of claude, so tests need no
// real claude binary. It records the args the "claude" would have received.
type fakePTY struct{ lastSpec ptyman.Spec }

func (f *fakePTY) Spawn(ctx context.Context, spec ptyman.Spec) (ptyman.Session, error) {
	f.lastSpec = spec
	// Echo the args back so the test can assert --session-id was passed, then read a line, then exit.
	var real ptyman.Spec
	if runtime.GOOS == "windows" {
		real = ptyman.Spec{Command: "cmd.exe", Args: []string{"/V:ON", "/Q", "/C", "echo args:" + join(spec.Args) + " & set /p x=& echo got:!x! & exit /b 7"}, Dir: spec.Dir}
	} else {
		real = ptyman.Spec{Command: "/bin/sh", Args: []string{"-c", "echo args:" + join(spec.Args) + "; read x; echo got:$x; exit 7"}, Dir: spec.Dir}
	}
	return ptyman.New().Spawn(ctx, real)
}

func newMgr(t *testing.T) (*Manager, *store.Store) {
	t.Helper()
	st, err := store.Open(context.Background(), ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	f := &fakePTY{}
	m := &Manager{pty: f, store: st, log: nil, dataDir: t.TempDir(), claude: "claude", agents: map[string]*Agent{}, NewSessionID: func() string { return "fixed-session-id" }}
	m.log = discardLogger()
	_ = f
	return m, st
}

func TestSpawnForcesSessionIDAndRecordsExit(t *testing.T) {
	if runtime.GOOS != "windows" {
		if _, err := exec.LookPath("sh"); err != nil {
			t.Skip("no sh")
		}
	}
	m, st := newMgr(t)
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
	// Output includes the forced --session-id and --model.
	sub, cancel := a.Subscribe()
	defer cancel()
	var buf bytes.Buffer
	deadline := time.After(5 * time.Second)
	for !bytes.Contains(buf.Bytes(), []byte("args:")) {
		select {
		case b, ok := <-sub:
			if !ok {
				t.Fatalf("stream closed early: %q", buf.String())
			}
			buf.Write(b)
		case <-deadline:
			t.Fatalf("no args line: %q", buf.String())
		}
	}
	if !bytes.Contains(buf.Bytes(), []byte("--session-id fixed-session-id")) || !bytes.Contains(buf.Bytes(), []byte("--model claude-opus-5")) {
		t.Fatalf("args missing: %q", buf.String())
	}
	// Type a line; the fake echoes it and exits 7.
	if err := m.Input("fixed-session-id", []byte("hi\n")); err != nil {
		t.Fatal(err)
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
	m, _ := newMgr(t)
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
