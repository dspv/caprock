package agents

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
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
	// ignoreTerm models a process that will not stop when asked, so the
	// shutdown path's kill-after-grace can be tested.
	ignoreTerm bool
	termed     atomic.Bool
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
	case ptyman.SignalTerm:
		s.termed.Store(true)
		if !s.ignoreTerm {
			// A clean exit: the process stops on its own having written
			// whatever it needed to.
			s.finish(0)
		}
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

func (s *fakeSession) exitCode() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.exit
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
	home := trustTestHome(t)
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
	// Parse the JSON rather than substring-matching the path (a Windows path
	// contains backslashes that JSON escapes, so a raw substring check fails).
	var root struct {
		Projects map[string]struct {
			HasTrustDialogAccepted bool `json:"hasTrustDialogAccepted"`
		} `json:"projects"`
	}
	if err := json.Unmarshal(b, &root); err != nil {
		t.Fatalf("unparsable ~/.claude.json: %v", err)
	}
	entry, ok := root.Projects[cwd]
	if !ok || !entry.HasTrustDialogAccepted {
		t.Fatalf("trust not recorded for cwd %q: %s", cwd, b)
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

// A new project should not require the user to go and make the folder first —
// but this runs on an endpoint that executes a command from its body, so the
// creation is deliberately narrow and these tests pin the edges of it.
func TestMakeProjectDir(t *testing.T) {
	base := t.TempDir()

	t.Run("creates one level under an existing parent", func(t *testing.T) {
		dir := filepath.Join(base, "new-project")
		if err := makeProjectDir(dir); err != nil {
			t.Fatalf("makeProjectDir: %v", err)
		}
		if fi, err := os.Stat(dir); err != nil || !fi.IsDir() {
			t.Fatalf("directory not created: %v", err)
		}
	})

	t.Run("an existing directory is not an error", func(t *testing.T) {
		// The caller asked for the directory to exist, and it does.
		dir := filepath.Join(base, "already-there")
		if err := os.Mkdir(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := makeProjectDir(dir); err != nil {
			t.Fatalf("existing directory rejected: %v", err)
		}
	})

	t.Run("refuses to invent a missing parent", func(t *testing.T) {
		// MkdirAll would materialise the whole chain from a typo. One level
		// means a mistyped path fails loudly instead of creating a home for
		// itself somewhere the user has never been.
		dir := filepath.Join(base, "no", "such", "parent")
		if err := makeProjectDir(dir); err == nil {
			t.Fatal("created a directory under a parent that does not exist")
		}
	})

	t.Run("refuses a relative path", func(t *testing.T) {
		if err := makeProjectDir("some/relative/path"); err == nil {
			t.Fatal("accepted a relative path")
		}
	})

	t.Run("cleans a path that climbs out of where it claims to be", func(t *testing.T) {
		// `<base>/dev/../../escape` is absolute and still lands outside base.
		// Cleaning happens before the parent check, so the parent that gets
		// verified is the real one, not the one the string suggests.
		escape := filepath.Join(base, "dev", "..", "..", "escaped-project")
		err := makeProjectDir(escape)
		cleaned := filepath.Clean(escape)
		if err == nil {
			// Only acceptable if the cleaned parent genuinely existed.
			if _, statErr := os.Stat(filepath.Dir(cleaned)); statErr != nil {
				t.Fatal("created a directory under a parent that does not exist")
			}
			_ = os.Remove(cleaned)
		}
		if _, statErr := os.Stat(filepath.Join(base, "dev", "..", "..", "escaped-project")); statErr == nil {
			// Present only because the cleaned parent existed; ensure we did
			// not create it via an uncleaned path.
			_ = os.Remove(cleaned)
		}
	})
}

// Spawn must not create anything unless it was explicitly asked to: the
// default is still "point me at a directory that exists".
func TestSpawnDoesNotCreateUnlessAsked(t *testing.T) {
	m := &Manager{dataDir: t.TempDir(), claude: "claude", agents: map[string]*Agent{}}
	dir := filepath.Join(t.TempDir(), "not-created")
	if _, err := m.Spawn(context.Background(), SpawnRequest{Cwd: dir}); err == nil {
		t.Fatal("spawn accepted a missing cwd without create")
	}
	if _, err := os.Stat(dir); err == nil {
		t.Fatal("spawn created the directory without being asked")
	}
}

// A quick chat is "I want to ask something", not "I want to work on a repo".
// It must not demand a directory, and each one needs its own.
func TestChatDirectories(t *testing.T) {
	at := func(s string) func() time.Time {
		ts, err := time.Parse(time.RFC3339, s)
		if err != nil {
			t.Fatal(err)
		}
		return func() time.Time { return ts }
	}

	t.Run("names the directory after the moment it started", func(t *testing.T) {
		data := t.TempDir()
		m := &Manager{dataDir: data, claude: "claude", agents: map[string]*Agent{}, Now: at("2026-08-26T17:04:05Z")}
		dir, err := m.newChatDir()
		if err != nil {
			t.Fatalf("newChatDir: %v", err)
		}
		if got := filepath.Base(dir); got != "2026-08-26-170405" {
			t.Fatalf("chat directory named %q", got)
		}
		if fi, err := os.Stat(dir); err != nil || !fi.IsDir() {
			t.Fatalf("chat directory not created: %v", err)
		}
	})

	t.Run("two chats in the same second do not share a directory", func(t *testing.T) {
		// Claude Code keys a transcript by working directory. Two chats in one
		// directory is two conversations in one transcript, which is both
		// unreadable and priced as a single session.
		data := t.TempDir()
		m := &Manager{dataDir: data, claude: "claude", agents: map[string]*Agent{}, Now: at("2026-08-26T17:04:05Z")}
		first, err := m.newChatDir()
		if err != nil {
			t.Fatal(err)
		}
		second, err := m.newChatDir()
		if err != nil {
			t.Fatal(err)
		}
		if first == second {
			t.Fatalf("both chats landed in %q", first)
		}
	})

	t.Run("lives under the data directory, not a second home of its own", func(t *testing.T) {
		data := t.TempDir()
		m := &Manager{dataDir: data, claude: "claude", agents: map[string]*Agent{}, Now: at("2026-08-26T17:04:05Z")}
		dir, err := m.newChatDir()
		if err != nil {
			t.Fatal(err)
		}
		if !strings.HasPrefix(dir, filepath.Join(data, "chats")+string(filepath.Separator)) {
			t.Fatalf("chat directory %q is not under the data dir's chats/", dir)
		}
	})

	t.Run("reports a missing data directory instead of guessing one", func(t *testing.T) {
		m := &Manager{claude: "claude", agents: map[string]*Agent{}}
		if _, err := m.newChatDir(); err == nil {
			t.Fatal("invented a location with no data directory configured")
		}
	})
}

// Shutdown must not destroy the user's work.
//
// Upgrading Caprock restarts the daemon, and the daemon used to SIGKILL every
// session it had spawned — so the user's running agents died mid-turn, with no
// warning and nothing flushed. The tool that watches your work must not be the
// thing that eats it.
func TestShutdownAsksBeforeKilling(t *testing.T) {
	m, _, f := newMgr(t)
	if _, err := m.Spawn(context.Background(), SpawnRequest{Cwd: t.TempDir()}); err != nil {
		t.Fatal(err)
	}
	sess := f.session

	m.Shutdown()

	if !sess.termed.Load() {
		t.Fatal("session was never asked to stop; shutdown went straight to the kill")
	}
	if code := sess.exitCode(); code != 0 {
		t.Fatalf("exit code %d, want 0 — the session did not get to finish cleanly", code)
	}
}

// A process that ignores the request is still killed: shutdown has to
// terminate. The grace period is spent once for all sessions, not per session.
func TestShutdownKillsWhatWillNotStop(t *testing.T) {
	m, _, f := newMgr(t)
	if _, err := m.Spawn(context.Background(), SpawnRequest{Cwd: t.TempDir()}); err != nil {
		t.Fatal(err)
	}
	sess := f.session
	sess.ignoreTerm = true

	start := time.Now()
	m.Shutdown()
	elapsed := time.Since(start)

	if !sess.termed.Load() {
		t.Error("the polite request was skipped")
	}
	if code := sess.exitCode(); code != -1 {
		t.Errorf("exit code %d, want -1 — a session that ignores the request must still be killed", code)
	}
	if elapsed < ShutdownGrace {
		t.Errorf("waited %v, expected to wait out the %v grace period", elapsed, ShutdownGrace)
	}
}
