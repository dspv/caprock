package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dspv/caprock/internal/config"
)

// The root command must wire every documented subcommand, including the hidden
// `hook` fallback the installer registers when no caprock-hook binary exists.
func TestRootHasAllSubcommands(t *testing.T) {
	root := newRoot()
	have := map[string]bool{}
	for _, c := range root.Commands() {
		have[c.Name()] = true
	}
	for _, want := range []string{"up", "down", "status", "tasks", "hooks", "hook", "version"} {
		if !have[want] {
			t.Fatalf("root is missing subcommand %q (have %v)", want, have)
		}
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
