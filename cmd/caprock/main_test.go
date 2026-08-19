package main

import (
	"bytes"
	"os"
	"path/filepath"
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
