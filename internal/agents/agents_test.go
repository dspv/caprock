package agents

import (
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/ptyman"
	"github.com/dspv/caprock/internal/store"
)

// fakePTY is a pure in-process ptyman backend: no shell, no real process, no
// ConPTY — so the manager's contract (forced --session-id, ownership, input
// routing, exit recording) is tested identically and deterministically on every
// OS. Real PTY spawn/stream/kill is covered by the -tags smoke and -tags
// ptyspike tests.
type fakePTY struct {
	lastSpec ptyman.Spec
	session  *fakeSession
}

func (f *fakePTY) Spawn(_ context.Context, spec ptyman.Spec) (ptyman.Session, error) {
	f.lastSpec = spec
	f.session = &fakeSession{pid: 4242, out: make(chan []byte, 16), done: make(chan struct{}), input: make(chan []byte, 16)}
	return f.session, nil
}

// fakeSession implements ptyman.Session in memory. Writing "exit\n" ends it with
// code 7; Signal(kill) ends it with code -1.
type fakeSession struct {
	pid    int
	out    chan []byte
	input  chan []byte
	done   chan struct{}
	mu     sync.Mutex
	exit   int
	closed bool
	paused bool
}

func (s *fakeSession) Output() io.Reader { return &chanReader{ch: s.out, done: s.done} }
func (s *fakeSession) Write(p []byte) (int, error) {
	if strings.Contains(string(p), "exit") {
		s.finish(7)
	}
	return len(p), nil
}
func (s *fakeSession) Resize(int, int) error { return nil }
func (s *fakeSession) Signal(sig ptyman.Signal) error {
	switch sig {
	case ptyman.SignalPause:
		s.paused = true
	case ptyman.SignalResume:
		s.paused = false
	case ptyman.SignalKill:
		s.finish(-1)
	}
	return nil
}
func (s *fakeSession) Wait() error {
	<-s.done
	if s.exit == 7 {
		return exitErr(7)
	}
	return nil
}

type exitErr int

func (e exitErr) Error() string     { return "exit status 7" }
func (e exitErr) ExitCode() int     { return int(e) }
func (s *fakeSession) PID() int     { return s.pid }
func (s *fakeSession) Paused() bool { return s.paused }
func (s *fakeSession) Close() error { s.finish(-1); return nil }
func (s *fakeSession) finish(code int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	s.closed, s.exit = true, code
	close(s.done)
	close(s.out)
}

type chanReader struct {
	ch   chan []byte
	done chan struct{}
	buf  []byte
}

func (r *chanReader) Read(p []byte) (int, error) {
	if len(r.buf) == 0 {
		select {
		case b, ok := <-r.ch:
			if !ok {
				return 0, io.EOF
			}
			r.buf = b
		case <-r.done:
			return 0, io.EOF
		}
	}
	n := copy(p, r.buf)
	r.buf = r.buf[n:]
	return n, nil
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
	// Control on a session Caprock did not spawn is always refused.
	if err := m.Input("external", []byte("x")); err == nil {
		t.Fatal("wrote into a non-owned session")
	}
	_ = a
	// Typing "exit" ends the in-memory fake with code 7; the manager records it.
	if err := m.Input("fixed-session-id", []byte("exit\n")); err != nil {
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
	s, _ = store.GetSession(ctx, st.DB(), "fixed-session-id")
	if s.Status != store.StatusEnded || s.ExitCode == nil || *s.ExitCode != 7 {
		t.Fatalf("exit not recorded: %+v", s)
	}
	if _, ok := m.Get("fixed-session-id"); ok {
		t.Fatal("still listed after exit")
	}
}

// The core rule: Caprock never signals a process it did not start. Every control
// op on a session it did not spawn must be refused — not just Input, but the
// destructive ones (pause/resume/kill) and Resize too.
func TestControlRefusedForNonOwnedSession(t *testing.T) {
	m, _, _ := newMgr(t)
	defer m.Shutdown()
	const external = "not-ours"
	if err := m.Input(external, []byte("x")); err == nil {
		t.Fatal("Input into a non-owned session was allowed")
	}
	for _, sig := range []ptyman.Signal{ptyman.SignalPause, ptyman.SignalResume, ptyman.SignalKill} {
		if err := m.Signal(external, sig); err == nil {
			t.Fatalf("Signal %v on a non-owned session was allowed", sig)
		}
	}
	if err := m.Resize(external, 80, 24); err == nil {
		t.Fatal("Resize of a non-owned session was allowed")
	}
}

// A spawned session must be a normal top-level Claude Code session: the daemon's
// own Claude/Caprock nesting markers are stripped so transcripts persist and it
// is not treated as a "child session".
func TestSpawnStripsNestingEnv(t *testing.T) {
	t.Setenv("CLAUDE_CODE_CHILD_SESSION", "1")
	t.Setenv("CLAUDECODE", "1")
	t.Setenv("CLAUDE_CODE_ENTRYPOINT", "cli")
	m, _, f := newMgr(t)
	defer m.Shutdown()
	if _, err := m.Spawn(context.Background(), SpawnRequest{Cwd: t.TempDir()}); err != nil {
		t.Fatal(err)
	}
	for _, kv := range f.lastSpec.Env {
		for _, marker := range []string{"CLAUDE_CODE_CHILD_SESSION=", "CLAUDECODE=", "CLAUDE_CODE_ENTRYPOINT="} {
			if strings.HasPrefix(kv, marker) {
				t.Fatalf("nesting marker not stripped from spawn env: %q", kv)
			}
		}
	}
}

// Spawn pre-accepts the folder-trust dialog for its cwd, so the interactive
// session does not block on the trust prompt. This guards the integration (a
// refactor dropping the trustFolder call would be caught here, not just in the
// helper's own unit test).
func TestSpawnPreacceptsFolderTrust(t *testing.T) {
	home := t.TempDir()
	origHome := userHomeDir
	userHomeDir = func() (string, error) { return home, nil }
	t.Cleanup(func() { userHomeDir = origHome })
	m, _, _ := newMgr(t)
	defer m.Shutdown()
	cwd := t.TempDir()
	if _, err := m.Spawn(context.Background(), SpawnRequest{Cwd: cwd}); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(home, ".claude.json"))
	if err != nil {
		t.Fatalf("spawn did not write ~/.claude.json (trust not pre-accepted): %v", err)
	}
	if !strings.Contains(string(b), "hasTrustDialogAccepted") || !strings.Contains(string(b), cwd) {
		t.Fatalf("trust not recorded for cwd: %s", b)
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
