package agents

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"os"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/ptyhost"
	"github.com/dspv/caprock/internal/ptyman"
	"github.com/dspv/caprock/internal/store"
)

// envShellHolder makes the test binary a pty-host; argShellChild, its last
// argument, makes it the shell (an argument, because a shell gets the login
// environment, not this process's).
const (
	envShellHolder = "CAPROCK_AGENTS_TEST_HOLDER"
	argShellChild  = "caprock-test-shell"
)

// runAsHelper turns the test binary into a pty-host or into a stand-in
// shell when the environment says so, and reports whether it did (it then
// never returns).
func runAsHelper() bool {
	switch {
	case os.Getenv(envShellHolder) == "1":
		os.Exit(ptyhost.Main(os.Stdin, os.Stdout))
	case len(os.Args) > 1 && os.Args[len(os.Args)-1] == argShellChild:
		fmt.Print("shell ready\r\n")
		sc := bufio.NewScanner(os.Stdin)
		for sc.Scan() {
			line := strings.TrimSpace(sc.Text())
			if line == "exit" {
				os.Exit(0)
			}
			fmt.Printf("ran:%s\r\n", line)
		}
		os.Exit(0)
	}
	return false
}

// A shell is not a session: it leaves no row and no event, so it is in no
// total, no Now card, no export and no count — whatever a query forgets.
func TestAShellIsInNoTotal(t *testing.T) {
	m, st, f := newMgr(t)
	defer m.Shutdown()
	m.shellCmd = func() (string, []string) { return "/bin/fake-shell", []string{"-l"} }
	ctx := context.Background()
	sh, err := m.SpawnShell(ctx, ShellRequest{Cwd: t.TempDir(), Cols: 100, Rows: 30})
	if err != nil {
		t.Fatal(err)
	}
	if sh.Kind != KindShell || f.lastSpec.Meta[metaKind] != KindShell {
		t.Fatalf("kind = %q, meta = %v; a restart would not know it is a shell", sh.Kind, f.lastSpec.Meta)
	}
	if f.lastSpec.Command != "/bin/fake-shell" || f.lastSpec.Cols != 100 {
		t.Fatalf("spec = %+v", f.lastSpec)
	}
	var sessions, events int
	_ = st.DB().QueryRowContext(ctx, `SELECT COUNT(*) FROM sessions`).Scan(&sessions)
	_ = st.DB().QueryRowContext(ctx, `SELECT COUNT(*) FROM events`).Scan(&events)
	if sessions != 0 || events != 0 {
		t.Fatalf("a shell wrote %d sessions and %d events; it would be counted", sessions, events)
	}
	if got := m.OwnedRunning(); len(got) != 0 {
		t.Fatalf("OwnedRunning = %v; the spend cap would pause a shell, and the status count would include it", got)
	}
	if got := m.Shells(); len(got) != 1 || got[0].SessionID != sh.SessionID || !m.IsShell(sh.SessionID) {
		t.Fatalf("Shells = %v", got)
	}
	// It is a terminal like any other: typed into, and ended.
	if err := m.Input(sh.SessionID, []byte("ls\r")); err != nil {
		t.Fatal(err)
	}
	if err := m.Signal(sh.SessionID, ptyman.SignalKill); err != nil {
		t.Fatal(err)
	}
	select {
	case <-sh.Done():
	case <-time.After(3 * time.Second):
		t.Fatal("killed shell did not end")
	}
	_ = st.DB().QueryRowContext(ctx, `SELECT COUNT(*) FROM sessions`).Scan(&sessions)
	if sessions != 0 {
		t.Fatal("a shell's exit wrote a session row")
	}
}

// A shell's foreground program is read for shells only, and at most once per
// fgTTL however often the list is polled.
func TestShellProgramIsCachedAndShellOnly(t *testing.T) {
	m, _, _ := newMgr(t)
	defer m.Shutdown()
	m.shellCmd = func() (string, []string) { return "/bin/fake-shell", []string{"-l"} }
	var calls int
	prog := "claude"
	old := foreground
	foreground = func(int) string { calls++; return prog }
	t.Cleanup(func() { foreground = old })

	sh, err := m.SpawnShell(context.Background(), ShellRequest{Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	for range 3 {
		if got := m.ShellProgram(sh.SessionID); got != "claude" {
			t.Fatalf("ShellProgram = %q, want claude", got)
		}
	}
	if calls != 1 {
		t.Fatalf("read the process table %d times in one TTL, want 1", calls)
	}
	sh.fg.mu.Lock()
	sh.fg.at = time.Now().Add(-fgTTL - time.Second)
	sh.fg.mu.Unlock()
	prog = ""
	if got := m.ShellProgram(sh.SessionID); got != "" || calls != 2 {
		t.Fatalf("after the TTL: %q in %d reads, want idle in 2", got, calls)
	}
	if got := m.ShellProgram("no-such-shell"); got != "" || calls != 2 {
		t.Fatalf("an unknown id was read: %q, %d reads", got, calls)
	}
}

func TestAShellNeedsAFolder(t *testing.T) {
	m, _, _ := newMgr(t)
	if _, err := m.SpawnShell(context.Background(), ShellRequest{Cwd: t.TempDir() + "/missing"}); err == nil {
		t.Fatal("a shell started in a folder that does not exist")
	}
}

// The login shell: $SHELL -l from the login environment on POSIX; on
// Windows PowerShell 7, Windows PowerShell or cmd.exe.
func TestTheLoginShell(t *testing.T) {
	m := &Manager{}
	cmd, args := m.loginShell([]string{"SHELL=" + os.Args[0]})
	if runtime.GOOS == "windows" {
		low := strings.ToLower(cmd)
		if !strings.HasSuffix(low, "pwsh.exe") && !strings.HasSuffix(low, "powershell.exe") && !strings.HasSuffix(low, "cmd.exe") {
			t.Fatalf("windows shell = %q", cmd)
		}
		return
	}
	if cmd != os.Args[0] || len(args) != 1 || args[0] != "-l" {
		t.Fatalf("shell = %q %v; want the login environment's SHELL as a login shell", cmd, args)
	}
}

// A shell lives in a pty-host, so a daemon restart leaves it running: the
// next manager finds it, repaints it and types into it — and still writes no
// session row for it.
func TestAShellSurvivesADaemonRestart(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	data := t.TempDir()
	hosts := func(m *Manager) {
		m.hosts = &ptyhost.Manager{Exe: exe, Args: []string{}, Env: append(os.Environ(), envShellHolder+"=1"), DataDir: data, Version: "test", Log: discardLogger()}
		m.pty = m.hosts
	}
	newHosted := func() (*Manager, *store.Store) {
		st, err := store.Open(context.Background(), ":memory:", nil)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = st.Close() })
		m := &Manager{store: st, log: discardLogger(), dataDir: data, agents: map[string]*Agent{}, NewSessionID: func() string { return "shell-survives" }}
		hosts(m)
		m.shellCmd = func() (string, []string) { return exe, []string{argShellChild} }
		return m, st
	}
	m1, _ := newHosted()
	sh, err := m1.SpawnShell(context.Background(), ShellRequest{Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	out := collect(sh)
	out.waitFor(t, "shell ready")
	if err := m1.Input(sh.SessionID, []byte("before\r")); err != nil {
		t.Fatal(err)
	}
	out.waitFor(t, "ran:before")
	m1.Shutdown()

	m2, st2 := newHosted()
	back := m2.Reattach(context.Background())
	if len(back) != 1 || back[0].Kind != KindShell || !m2.IsShell("shell-survives") {
		t.Fatalf("reattached %v; the shell did not come back as a shell", back)
	}
	out2 := collect(back[0])
	if err := m2.Input("shell-survives", []byte("after\r")); err != nil {
		t.Fatal(err)
	}
	out2.waitFor(t, "ran:after")
	var sessions int
	_ = st2.DB().QueryRow(`SELECT COUNT(*) FROM sessions`).Scan(&sessions)
	if sessions != 0 {
		t.Fatal("reattaching a shell wrote a session row")
	}
	_ = m2.Input("shell-survives", []byte("exit\r"))
	select {
	case <-back[0].Done():
	case <-time.After(10 * time.Second):
		t.Fatal("the shell did not end")
	}
}

type collected struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func collect(a *Agent) *collected {
	c := &collected{}
	c.buf.Write(a.Snapshot())
	ch, _ := a.Subscribe()
	go func() {
		for b := range ch {
			c.mu.Lock()
			c.buf.Write(b)
			c.mu.Unlock()
		}
	}()
	return c
}

func (c *collected) waitFor(t *testing.T, want string) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		c.mu.Lock()
		hit := strings.Contains(c.buf.String(), want)
		c.mu.Unlock()
		if hit {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	t.Fatalf("timed out waiting for %q; got %q", want, c.buf.String())
}
