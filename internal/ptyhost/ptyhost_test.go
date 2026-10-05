// The pty-host is what keeps a session alive when the daemon restarts, so the
// tests here play both sides of that: a daemon that starts a session, lets go
// of it, and a second daemon that finds it, repaints it and types into it.
//
// The test binary stands in for both other processes. With one environment
// variable it runs as the holder (`caprock pty-host`); with another as the
// child, a tiny line-echo REPL that behaves the same under a POSIX PTY and
// ConPTY — which a shell script would not.
package ptyhost

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/ptyman"
)

const (
	envHolder = "CAPROCK_PTYHOST_TEST_HOLDER"
	envChild  = "CAPROCK_PTYHOST_TEST_CHILD"
	// envPreV2 makes the holder one from before terminal protocol v2.
	envPreV2 = "CAPROCK_PTYHOST_TEST_PREV2"
)

func TestMain(m *testing.M) {
	switch {
	case os.Getenv(envHolder) == "1":
		preV2 = os.Getenv(envPreV2) == "1"
		os.Exit(Main(os.Stdin, os.Stdout))
	case os.Getenv(envChild) == "1":
		fmt.Print("child ready\r\n")
		sc := bufio.NewScanner(os.Stdin)
		for sc.Scan() {
			line := strings.TrimSpace(sc.Text())
			if line == "quit" {
				fmt.Print("bye\r\n")
				os.Exit(3)
			}
			fmt.Printf("you-said:%s\r\n", line)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// childEnv is the child's environment: everything this process has, minus the
// holder switch (or the child would start another holder), plus the child's.
func childEnv() []string {
	var env []string
	for _, kv := range os.Environ() {
		if strings.HasPrefix(kv, envHolder+"=") || strings.HasPrefix(kv, envPreV2+"=") {
			continue
		}
		env = append(env, kv)
	}
	return append(env, envChild+"=1", "TERM=xterm-256color")
}

func newManager(t *testing.T, dataDir string) *Manager {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	return &Manager{Exe: exe, Args: []string{}, Env: append(os.Environ(), envHolder+"=1"), DataDir: dataDir, Version: "test"}
}

func childSpec(t *testing.T, id string) ptyman.Spec {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	return ptyman.Spec{ID: id, Command: exe, Dir: t.TempDir(), Env: childEnv(), Cols: 100, Rows: 30}
}

// reader accumulates a session's output so a test can wait for a string.
type reader struct {
	mu  sync.Mutex
	buf bytes.Buffer
	eof chan struct{}
}

func readAll(r io.Reader) *reader {
	rd := &reader{eof: make(chan struct{})}
	go func() {
		defer close(rd.eof)
		b := make([]byte, 4096)
		for {
			n, err := r.Read(b)
			if n > 0 {
				rd.mu.Lock()
				rd.buf.Write(b[:n])
				rd.mu.Unlock()
			}
			if err != nil {
				return
			}
		}
	}()
	return rd
}

func (rd *reader) waitFor(t *testing.T, want string) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		rd.mu.Lock()
		hit := strings.Contains(rd.buf.String(), want)
		rd.mu.Unlock()
		if hit {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	rd.mu.Lock()
	defer rd.mu.Unlock()
	t.Fatalf("timed out waiting for %q; got %q", want, rd.buf.String())
}

func waitGone(t *testing.T, path string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("%s is still there", path)
}

// The whole point: start, let go, come back, see the screen, type, end.
func TestSessionSurvivesItsDaemon(t *testing.T) {
	data := t.TempDir()
	m := newManager(t, data)
	spec := childSpec(t, "s-survive")
	// What the next daemon needs to keep watching the session — which agent,
	// an OpenCode server's port — must come back with it.
	spec.Meta = map[string]string{"kind": "opencode", "port": "4096"}
	s, err := m.Spawn(context.Background(), spec)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := s.(ptyman.Detacher); !ok {
		t.Fatal("a hosted session must be detachable")
	}
	if s.PID() == 0 {
		t.Fatal("no child pid")
	}
	childPID := s.PID()
	out := readAll(s.Output())
	out.waitFor(t, "child ready")
	if _, err := s.Write([]byte("before\r")); err != nil {
		t.Fatal(err)
	}
	out.waitFor(t, "you-said:before")

	// The daemon goes away. The session must not notice.
	if err := s.(ptyman.Detacher).Detach(); err != nil {
		t.Fatal(err)
	}
	if err := s.Wait(); !errors.Is(err, ptyman.ErrDetached) {
		t.Fatalf("Wait after Detach = %v; a detach is not an exit", err)
	}
	if _, err := os.Stat(recordPath(Dir(data), "s-survive")); err != nil {
		t.Fatalf("the holder's registry entry is gone after a detach: %v", err)
	}

	// A new daemon — a new Manager, as after a restart — finds it.
	m2 := newManager(t, data)
	att, exits := m2.Reattach()
	if len(exits) != 0 || len(att) != 1 {
		t.Fatalf("reattach found %d sessions and %d exits; want 1 and 0", len(att), len(exits))
	}
	a := att[0]
	if a.Record.Meta["kind"] != "opencode" || a.Record.Meta["port"] != "4096" {
		t.Fatalf("reattached meta = %v; the agent and its port were lost", a.Record.Meta)
	}
	if a.Record.SessionID != "s-survive" || a.Session.PID() != childPID {
		t.Fatalf("reattached %+v pid %d; want s-survive pid %d", a.Record, a.Session.PID(), childPID)
	}
	out2 := readAll(a.Session.Output())
	// The holder's ring repaints what happened before the restart.
	out2.waitFor(t, "you-said:before")
	if err := a.Session.Resize(90, 25); err != nil {
		t.Fatal(err)
	}
	if _, err := a.Session.Write([]byte("after\r")); err != nil {
		t.Fatal(err)
	}
	out2.waitFor(t, "you-said:after")
	if _, err := a.Session.Write([]byte("quit\r")); err != nil {
		t.Fatal(err)
	}
	err = a.Session.Wait()
	var ee ExitError
	if !errors.As(err, &ee) || ee.ExitCode() != 3 {
		t.Fatalf("exit = %v; want code 3", err)
	}
	waitGone(t, recordPath(Dir(data), "s-survive"))
	if _, err := os.Stat(exitPath(Dir(data), "s-survive")); err == nil {
		t.Fatal("an exit a daemon heard must not also be left on disk")
	}
}

// A session that ends while no daemon is connected leaves its exit code for
// the next one.
func TestExitWhileDetachedIsRecorded(t *testing.T) {
	data := t.TempDir()
	m := newManager(t, data)
	s, err := m.Spawn(context.Background(), childSpec(t, "s-exit"))
	if err != nil {
		t.Fatal(err)
	}
	out := readAll(s.Output())
	out.waitFor(t, "child ready")
	// Type the quit and let go before the reply: the holder is alone when the
	// child exits.
	if _, err := s.Write([]byte("quit\r")); err != nil {
		t.Fatal(err)
	}
	_ = s.(ptyman.Detacher).Detach()
	deadline := time.Now().Add(10 * time.Second)
	for {
		if _, err := os.Stat(exitPath(Dir(data), "s-exit")); err == nil {
			break
		}
		if time.Now().After(deadline) {
			// The child may have exited before the detach landed, in which
			// case the daemon heard it and nothing is on disk. Either is
			// correct; only "neither" is not.
			if errors.Is(s.Wait(), ptyman.ErrDetached) {
				t.Fatal("the child exited while detached and left no exit record")
			}
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	waitGone(t, recordPath(Dir(data), "s-exit"))
	att, exits := newManager(t, data).Reattach()
	if len(att) != 0 || len(exits) != 1 || exits[0].Code != 3 {
		t.Fatalf("reattach = %d sessions, exits %+v; want none and code 3", len(att), exits)
	}
	if _, err := os.Stat(exitPath(Dir(data), "s-exit")); err == nil {
		t.Fatal("a read exit record must be removed")
	}
}

// Kill from the dashboard still works: it goes through the holder.
func TestCloseKillsThroughTheHolder(t *testing.T) {
	data := t.TempDir()
	s, err := newManager(t, data).Spawn(context.Background(), childSpec(t, "s-kill"))
	if err != nil {
		t.Fatal(err)
	}
	readAll(s.Output()).waitFor(t, "child ready")
	if err := s.Signal(ptyman.SignalKill); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- s.Wait() }()
	select {
	case err := <-done:
		if errors.Is(err, ptyman.ErrDetached) {
			t.Fatalf("a killed session reported a detach: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the child did not exit after a kill")
	}
	_ = s.Close()
	waitGone(t, recordPath(Dir(data), "s-kill"))
}

// Only the daemon gets in: the token is checked before anything is served.
func TestWrongTokenIsRefused(t *testing.T) {
	data := t.TempDir()
	s, err := newManager(t, data).Spawn(context.Background(), childSpec(t, "s-token"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	b, err := os.ReadFile(recordPath(Dir(data), "s-token"))
	if err != nil {
		t.Fatal(err)
	}
	var rec Record
	if err := json.Unmarshal(b, &rec); err != nil {
		t.Fatal(err)
	}
	rec.Token = "not-the-token"
	if _, err := attach(Dir(data), rec, false); !errors.Is(err, errRefused) {
		t.Fatalf("attach with a wrong token = %v; want a refusal", err)
	}
}

// A registry entry nothing answers for is a holder that died without cleaning
// up; the next daemon removes it rather than carrying it forever.
func TestStaleRegistryEntryIsRemoved(t *testing.T) {
	data := t.TempDir()
	dir := Dir(data)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	_ = ln.Close() // nothing listens there now
	if err := writeJSONAtomic(recordPath(dir, "s-stale"), Record{Proto: Proto, SessionID: "s-stale", Addr: addr, Token: "t"}); err != nil {
		t.Fatal(err)
	}
	// And one that is not ours at all, which must be ignored, not parsed.
	if err := os.WriteFile(filepath.Join(dir, "notes.json"), []byte(`{"session_id":"elsewhere"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	att, _ := newManager(t, data).Reattach()
	if len(att) != 0 {
		t.Fatalf("reattached %d sessions to a dead holder", len(att))
	}
	if _, err := os.Stat(recordPath(dir, "s-stale")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("the stale registry entry was kept")
	}
}

// A session id that cannot be a file name never reaches the registry; the
// session starts in-process instead.
func TestUnsafeIDFallsBack(t *testing.T) {
	data := t.TempDir()
	m := newManager(t, data)
	fb := &countingManager{}
	m.Fallback = fb
	spec := childSpec(t, "../escape")
	if _, err := m.Spawn(context.Background(), spec); err == nil || fb.n != 1 {
		t.Fatalf("spawn with an unsafe id: err=%v fallback calls=%d; want the fallback used", err, fb.n)
	}
	if entries, _ := os.ReadDir(Dir(data)); len(entries) != 0 {
		t.Fatalf("an unsafe id wrote to the registry: %v", entries)
	}
}

type countingManager struct{ n int }

func (c *countingManager) Spawn(context.Context, ptyman.Spec) (ptyman.Session, error) {
	c.n++
	return nil, errors.New("fallback reached")
}

// A child that cannot start is the spawn's failure and is reported, not
// retried in-process to fail the same way.
func TestChildThatCannotStartIsReported(t *testing.T) {
	data := t.TempDir()
	m := newManager(t, data)
	fb := &countingManager{}
	m.Fallback = fb
	spec := childSpec(t, "s-missing")
	spec.Command = filepath.Join(t.TempDir(), "no-such-binary")
	_, err := m.Spawn(context.Background(), spec)
	if err == nil {
		t.Fatal("spawned a missing binary")
	}
	if fb.n != 0 {
		t.Fatal("a child that cannot start was retried in-process")
	}
}

func TestFrameRoundTripAndLimit(t *testing.T) {
	var b bytes.Buffer
	if err := writeFrame(&b, frameOutput, []byte("hello")); err != nil {
		t.Fatal(err)
	}
	typ, p, err := readFrame(&b)
	if err != nil || typ != frameOutput || string(p) != "hello" {
		t.Fatalf("round trip = %q %q %v", typ, p, err)
	}
	hdr := []byte{frameOutput, 0xff, 0xff, 0xff, 0xff}
	if _, _, err := readFrame(bytes.NewReader(hdr)); !errors.Is(err, errFrameTooLarge) {
		t.Fatalf("oversized frame = %v; want refused", err)
	}
}

func TestValidID(t *testing.T) {
	for _, ok := range []string{"0b5e7a1c-3f2d-4c1e-9a8b-1234567890ab", "s_1"} {
		if !validID(ok) {
			t.Errorf("%q refused", ok)
		}
	}
	for _, bad := range []string{"", "../x", "a/b", `a\b`, "a.json", strings.Repeat("a", 200)} {
		if validID(bad) {
			t.Errorf("%q accepted", bad)
		}
	}
}

// Continuing a session under its own id starts a new holder for the same id
// while the old one is still on its way out. The old holder must leave the
// successor's registry entry alone and not leave an exit code for a session
// that is running. Found in a browser check: the old holder deleted the new
// one's entry, so the next daemon could not find the session.
func TestOldHolderLeavesItsSuccessorsEntryAlone(t *testing.T) {
	data := t.TempDir()
	dir := Dir(data)
	s, err := newManager(t, data).Spawn(context.Background(), childSpec(t, "s-succ"))
	if err != nil {
		t.Fatal(err)
	}
	readAll(s.Output()).waitFor(t, "child ready")
	// A successor takes the id.
	successor := Record{Proto: Proto, SessionID: "s-succ", HostPID: 1, Addr: "127.0.0.1:1", Token: "successor"}
	if err := writeJSONAtomic(recordPath(dir, "s-succ"), successor); err != nil {
		t.Fatal(err)
	}
	_ = s.(ptyman.Detacher).Detach()
	// The old child ends with no daemon connected — the case that would
	// write an exit record, were the entry still the holder's.
	if p, err := os.FindProcess(s.PID()); err == nil {
		_ = p.Kill()
	}
	time.Sleep(3 * time.Second)
	b, err := os.ReadFile(recordPath(dir, "s-succ"))
	if err != nil {
		t.Fatalf("the old holder removed its successor's registry entry: %v", err)
	}
	var got Record
	if err := json.Unmarshal(b, &got); err != nil || got.Token != "successor" {
		t.Fatalf("the successor's entry was changed: %s", b)
	}
	if _, err := os.Stat(exitPath(dir, "s-succ")); err == nil {
		t.Fatal("the old holder left an exit record for a session that is running")
	}
}
