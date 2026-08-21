package main

import (
	"bytes"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/dspv/caprock/internal/config"
	"github.com/spf13/cobra"
)

// The root command must wire every documented subcommand, including the hidden
// `hook` fallback the installer registers when no caprock-hook binary exists.
func TestRootHasAllSubcommands(t *testing.T) {
	root := newRoot()
	have := map[string]bool{}
	for _, c := range root.Commands() {
		have[c.Name()] = true
	}
	for _, want := range []string{"up", "down", "status", "tasks", "hooks", "hook", "statusline", "version"} {
		if !have[want] {
			t.Fatalf("root is missing subcommand %q (have %v)", want, have)
		}
	}
	// statusline carries install/uninstall subcommands.
	var sl *cobra.Command
	for _, c := range root.Commands() {
		if c.Name() == "statusline" {
			sl = c
		}
	}
	if sl == nil {
		t.Fatal("no statusline command")
	}
	slSub := map[string]bool{}
	for _, c := range sl.Commands() {
		slSub[c.Name()] = true
	}
	if !slSub["install"] || !slSub["uninstall"] {
		t.Fatalf("statusline missing install/uninstall (have %v)", slSub)
	}
}

// lastLogError extracts the actionable cause from the daemon log on a failed
// start — most importantly the port-in-use footgun — or "" when the log has
// nothing useful. This keeps `caprock up` from showing a bare timeout.
func TestLastLogError(t *testing.T) {
	dir := t.TempDir()
	write := func(s string) string {
		p := filepath.Join(dir, "caprock.log")
		if err := os.WriteFile(p, []byte(s), 0o600); err != nil {
			t.Fatal(err)
		}
		return p
	}
	// Port in use → friendly, actionable message.
	got := lastLogError(write("time=... msg=\"listen tcp 127.0.0.1:4173: bind: address already in use\"\n"))
	if !strings.Contains(got, "already in use") || !strings.Contains(got, "caprock status") {
		t.Fatalf("port-in-use not surfaced: %q", got)
	}
	// A generic error line is returned verbatim.
	if got := lastLogError(write("line one\nlevel=error something broke\n")); !strings.Contains(got, "something broke") {
		t.Fatalf("error line not returned: %q", got)
	}
	// A panic is surfaced.
	if got := lastLogError(write("ok\npanic: boom\n")); !strings.Contains(got, "panic") {
		t.Fatalf("panic not surfaced: %q", got)
	}
	// A clean log yields "".
	if got := lastLogError(write("time=... msg=\"listening\"\ntime=... msg=\"ready\"\n")); got != "" {
		t.Fatalf("clean log should yield empty, got %q", got)
	}
	// A missing file yields "" (best-effort).
	if got := lastLogError(filepath.Join(dir, "nope.log")); got != "" {
		t.Fatalf("missing log should yield empty, got %q", got)
	}
}

// statuslineCommandStr is `<self> statusline`.
func TestStatuslineCommandStr(t *testing.T) {
	got := statuslineCommandStr()
	if !strings.HasSuffix(got, " statusline") {
		t.Fatalf("statusline command should end with ' statusline': %q", got)
	}
}

// shimCommand returns `<self> hook` when no standalone shim binary is present in
// the data dir — the fallback that keeps the shim working from a single binary.
func TestShimCommandFallsBackToSelfHook(t *testing.T) {
	dir := t.TempDir() // no shim binary inside
	got := shimCommand(dir)
	if !strings.HasSuffix(got, " hook") {
		t.Fatalf("expected `<self> hook` fallback, got %q", got)
	}
	// When a shim binary exists in the data dir, that path is used instead.
	shim := config.ShimPath(dir)
	if err := os.MkdirAll(filepath.Dir(shim), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(shim, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if got := shimCommand(dir); got != shim {
		t.Fatalf("expected shim path %q, got %q", shim, got)
	}
}

// `caprock version` dispatches and prints a version line — exercises the cobra
// wiring end to end (previously the CLI had no test at all).
func TestVersionCommandRuns(t *testing.T) {
	root := newRoot()
	var out bytes.Buffer
	root.SetOut(&out)
	root.SetArgs([]string{"version"})
	if err := root.Execute(); err != nil {
		t.Fatalf("version command errored: %v", err)
	}
	if !strings.Contains(out.String(), "caprock ") {
		t.Fatalf("version output unexpected: %q", out.String())
	}
}

// `caprock status` with no running daemon dispatches cleanly and reports the
// daemon as not running (rather than panicking).
func TestStatusCommandDaemonDown(t *testing.T) {
	t.Setenv(config.EnvDataDir, t.TempDir()) // empty data dir → no runtime.json
	root := newRoot()
	var out bytes.Buffer
	root.SetOut(&out)
	root.SetErr(&out)
	root.SetArgs([]string{"status"})
	_ = root.Execute() // may return a non-nil error; must not panic
	if out.Len() == 0 {
		t.Fatal("status produced no output with the daemon down")
	}
}

// ensureShim installs the binary that runs inside every hook of every session.
// Rule 3 lives or dies on that binary being present and correct: a missing one
// means nothing is recorded, and a stale one means the old code keeps running
// after an upgrade.
func TestEnsureShimIsIdempotentAndSelfHealing(t *testing.T) {
	dir := t.TempDir()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	src := filepath.Join(filepath.Dir(self), filepath.Base(config.ShimPath(dir)))

	// A test binary has no sibling shim, so without this the whole test takes
	// the "nothing to install" path and asserts nothing — it passed that way
	// first, which is exactly the kind of green that means nothing. Plant one.
	if _, err := os.Stat(src); err != nil {
		if err := os.WriteFile(src, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
			t.Skipf("cannot plant a shim beside the test binary: %v", err)
		}
		t.Cleanup(func() { _ = os.Remove(src) })
	}

	if err := ensureShim(dir); err != nil {
		t.Fatalf("first install: %v", err)
	}
	dst := config.ShimPath(dir)
	first, err := os.ReadFile(dst)
	if err != nil {
		t.Fatalf("shim was not installed: %v", err)
	}
	if fi, err := os.Stat(dst); err != nil || fi.Mode().Perm()&0o100 == 0 {
		t.Errorf("shim is not executable (mode %v); Claude Code could not run it", fi.Mode())
	}

	// Running again must not rewrite an identical file — the daemon calls this
	// on every start.
	if err := ensureShim(dir); err != nil {
		t.Fatalf("second install: %v", err)
	}

	// A stale shim must be replaced, or an upgraded Caprock keeps running the
	// previous version's hook code.
	if err := os.WriteFile(dst, []byte("stale"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := ensureShim(dir); err != nil {
		t.Fatalf("replacing a stale shim: %v", err)
	}
	after, err := os.ReadFile(dst)
	if err != nil {
		t.Fatal(err)
	}
	if string(after) == "stale" {
		t.Error("a stale shim survived; an upgrade would keep running old hook code")
	}
	if len(after) != len(first) {
		t.Errorf("replaced shim is %d bytes, original was %d", len(after), len(first))
	}
}

// confirm gates the hook install (ADR-019). The rule that matters is what it
// does when there is nobody to answer: a script or a CI run must not hang, and
// must not have consent assumed on its behalf.
func TestConfirmRefusesWithoutATTY(t *testing.T) {
	cmd := &cobra.Command{}
	var out bytes.Buffer
	cmd.SetOut(&out)

	// A pipe is not a terminal, which is what a script looks like.
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = r.Close(); _ = w.Close() })
	if _, err := w.WriteString("y\n"); err != nil {
		t.Fatal(err)
	}
	cmd.SetIn(r)

	if confirm(cmd, "install hooks? ") {
		t.Error("consent was assumed from a pipe; a script must not be taken as a yes")
	}
	if out.Len() != 0 {
		t.Errorf("prompted a non-interactive caller: %q", out.String())
	}
}

// A reader that is not a file at all — cobra's default in tests — must also be
// refused rather than panicking on the type assertion.
func TestConfirmRefusesANonFileReader(t *testing.T) {
	cmd := &cobra.Command{}
	cmd.SetIn(strings.NewReader("y\n"))
	if confirm(cmd, "install hooks? ") {
		t.Error("consent was assumed from a plain reader")
	}
}

// daemonAlive is how `caprock up` decides whether another instance is already
// running. A false positive would refuse to start for no reason; a false
// negative would start a second daemon on the same data directory.
func TestDaemonAliveOnADeadPort(t *testing.T) {
	// Bind and release, so the port is almost certainly free.
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	if err := l.Close(); err != nil {
		t.Fatal(err)
	}
	if daemonAlive(config.Runtime{Port: port}) {
		t.Error("reported a daemon on a port nothing is listening on")
	}
}

func TestDaemonAliveNeedsAHealthyAnswer(t *testing.T) {
	// Something is listening, but it is not us — a stale runtime.json pointing
	// at a port another program has since taken.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "not caprock", http.StatusNotFound)
	}))
	defer srv.Close()
	_, portStr, err := net.SplitHostPort(strings.TrimPrefix(srv.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	port, err := strconv.Atoi(portStr)
	if err != nil {
		t.Fatal(err)
	}
	if daemonAlive(config.Runtime{Port: port}) {
		t.Error("a 404 from an unrelated server was taken for a live daemon")
	}
}
