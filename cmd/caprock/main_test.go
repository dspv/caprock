package main

import (
	"bytes"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
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
	for _, want := range []string{"up", "down", "status", "tasks", "hooks", "hook", "statusline", "service", "version"} {
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
	// POSIX only: Windows has no executable bit — what makes a file runnable
	// there is the .exe extension, which the filename already carries.
	if runtime.GOOS != "windows" {
		if fi, err := os.Stat(dst); err != nil || fi.Mode().Perm()&0o100 == 0 {
			t.Errorf("shim is not executable (mode %v); Claude Code could not run it", fi.Mode())
		}
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

// fakeDaemon starts a loopback server answering /healthz plus the routes a test
// needs, and points $CAPROCK_DATA_DIR at a runtime.json describing it. It is how
// the CLI's HTTP-facing commands are exercised without a real daemon.
func fakeDaemon(t *testing.T, routes map[string]http.HandlerFunc) {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	for pat, h := range routes {
		mux.HandleFunc(pat, h)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: mux} //nolint:gosec // test server, loopback only
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })

	dir := t.TempDir()
	t.Setenv(config.EnvDataDir, dir)
	rt, err := config.NewRuntime(ln.Addr().(*net.TCPAddr).Port, "test")
	if err != nil {
		t.Fatal(err)
	}
	if err := config.WriteRuntime(dir, rt); err != nil {
		t.Fatal(err)
	}
}

func runCLI(t *testing.T, args ...string) (string, error) {
	t.Helper()
	root := newRoot()
	var out bytes.Buffer
	root.SetOut(&out)
	root.SetErr(&out)
	root.SetArgs(args)
	err := root.Execute()
	return out.String(), err
}

// `caprock tasks <anything>` used to ignore its arguments and print the list —
// a fake success for a command that does not exist. Someone reaching for
// `caprock tasks create` got the board back and no hint that nothing happened.
func TestTasksRejectsUnknownArguments(t *testing.T) {
	fakeDaemon(t, map[string]http.HandlerFunc{
		"/v1/tasks": func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(`[{"id":"t-1","title":"x","status":"inbox"}]`))
		},
	})
	out, err := runCLI(t, "tasks", "create")
	if err == nil {
		t.Fatalf("`caprock tasks create` succeeded; want an error. output: %q", out)
	}
	if strings.Contains(out, "t-1") {
		t.Fatalf("`caprock tasks create` printed the board instead of refusing: %q", out)
	}
}

// The id column was a hard-coded %-14s against ids generated as
// `t-<unix-millis>-<n>` — 17 characters — so every row of a real board ran its
// id into the status column. The width has to be measured, not guessed.
func TestTasksAlignsColumnsToTheWidestID(t *testing.T) {
	fakeDaemon(t, map[string]http.HandlerFunc{
		"/v1/tasks": func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(`[
				{"id":"t-1755000000000-1","title":"long id","status":"done","assignee":"worker-1","cost_usd":1.5},
				{"id":"t-2","title":"short id","status":"inbox","assignee":"","cost_usd":0}
			]`))
		},
	})
	out, err := runCLI(t, "tasks")
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	if len(lines) != 2 {
		t.Fatalf("want two rows, got %d: %q", len(lines), out)
	}
	// The status column must start at the same offset on every row.
	if a, b := strings.Index(lines[0], "done"), strings.Index(lines[1], "inbox"); a != b {
		t.Fatalf("status column misaligned: %d vs %d\n%s", a, b, out)
	}
	if strings.Contains(lines[0], "t-1755000000000-1done") {
		t.Fatalf("id ran into the status column: %q", lines[0])
	}
}

// `caprock task create` is the only way to fill the queue from a script or a
// terminal; before it, an unattended runner could only be fed through a form in
// the dashboard.
func TestTaskCreatePostsTheTask(t *testing.T) {
	var got map[string]any
	fakeDaemon(t, map[string]http.HandlerFunc{
		"POST /v1/tasks": func(w http.ResponseWriter, r *http.Request) {
			_ = json.NewDecoder(r.Body).Decode(&got)
			_, _ = w.Write([]byte(`{"task":{"id":"t-9","title":"Add /healthz"}}`))
		},
	})
	out, err := runCLI(t, "task", "create", "--title", "Add /healthz",
		"--done-criteria", "go test ./...", "--done-criteria", "go vet ./...", "--budget", "2.5")
	if err != nil {
		t.Fatalf("create failed: %v (%s)", err, out)
	}
	if got["title"] != "Add /healthz" {
		t.Fatalf("title not sent: %#v", got)
	}
	if b, _ := got["budget_usd"].(float64); b != 2.5 {
		t.Fatalf("budget not sent: %#v", got)
	}
	crit, _ := got["done_criteria"].([]any)
	if len(crit) != 2 || crit[0] != "go test ./..." {
		t.Fatalf("done_criteria not sent: %#v", got)
	}
	if !strings.Contains(out, "t-9") {
		t.Fatalf("created id not reported: %q", out)
	}
}

// A task with no done_criteria cannot be verified, and the runner's whole claim
// is that nothing is done until its checks pass. Refusing at the flag is
// cheaper than a task parked in needs_you an hour later.
func TestTaskCreateRequiresDoneCriteria(t *testing.T) {
	posted := false
	fakeDaemon(t, map[string]http.HandlerFunc{
		"POST /v1/tasks": func(w http.ResponseWriter, _ *http.Request) {
			posted = true
			_, _ = w.Write([]byte(`{"task":{"id":"t-9"}}`))
		},
	})
	out, err := runCLI(t, "task", "create", "--title", "no checks")
	if err == nil {
		t.Fatalf("create without --done-criteria succeeded; want a refusal (%s)", out)
	}
	if posted {
		t.Fatal("the request was sent anyway")
	}
}

// Which hive a running daemon was started with was reported nowhere — not in
// `caprock status`, not in /v1/status, not on the startup line — so there was no
// way to ask what it was orchestrating.
func TestStatusReportsTheHive(t *testing.T) {
	fakeDaemon(t, map[string]http.HandlerFunc{
		"/v1/status": func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(`{"version":"test","orchestration":true,"hive":"/tmp/my-hive","repo":"/tmp/my-repo","ui_built":true,"pricing":{"version":"1"}}`))
		},
	})
	out, err := runCLI(t, "status")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "/tmp/my-hive") {
		t.Fatalf("status did not name the hive: %q", out)
	}
	if !strings.Contains(out, "/tmp/my-repo") {
		t.Fatalf("status did not name the repo: %q", out)
	}
}

// With orchestration off the line must still appear, and say what turns it on —
// silence there is what made the feature undiscoverable in the first place.
func TestStatusSaysHowToTurnTheHiveOn(t *testing.T) {
	fakeDaemon(t, map[string]http.HandlerFunc{
		"/v1/status": func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(`{"version":"test","orchestration":false,"ui_built":true,"pricing":{"version":"1"}}`))
		},
	})
	out, err := runCLI(t, "status")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "--hive") {
		t.Fatalf("status did not say how to enable the task runner: %q", out)
	}
}

// "Phase 2" is our internal build order and means nothing to a user. It used to
// appear in `caprock tasks --help` and on the --hive flag.
func TestNoInternalPhaseWordingInHelp(t *testing.T) {
	root := newRoot()
	for _, c := range root.Commands() {
		var b bytes.Buffer
		c.SetOut(&b)
		c.SetErr(&b)
		if err := c.Usage(); err != nil {
			t.Fatal(err)
		}
		text := b.String() + c.Short + c.Long
		if strings.Contains(text, "Phase 2") || strings.Contains(text, "Phase 1") {
			t.Fatalf("`caprock %s` help leaks an internal phase name:\n%s", c.Name(), text)
		}
	}
}
