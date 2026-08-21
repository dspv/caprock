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

// findSub locates a subcommand by name, failing the test if it is not wired.
func findSub(t *testing.T, parent *cobra.Command, name string) *cobra.Command {
	t.Helper()
	for _, c := range parent.Commands() {
		if c.Name() == name {
			return c
		}
	}
	t.Fatalf("%s has no %q subcommand (have %d)", parent.Name(), name, len(parent.Commands()))
	return nil
}

// The whole command group must be reachable: a `service` with no install is a
// command that promises autostart and delivers nothing.
func TestServiceHasInstallUninstallStatus(t *testing.T) {
	svc := findSub(t, newRoot(), "service")
	for _, want := range []string{"install", "uninstall", "status"} {
		findSub(t, svc, want)
	}
}

// `caprock service status` is read-only and must work on a machine where
// nothing is installed — that is the first thing anyone runs. It also must not
// leave anything behind: status never writes.
func TestServiceStatusReportsNotInstalled(t *testing.T) {
	dataDir := t.TempDir()
	t.Setenv(config.EnvDataDir, dataDir)
	// Redirect the home so Path() resolves inside the test sandbox on every OS.
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home) // os.UserHomeDir reads this one on Windows
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
	t.Setenv("APPDATA", filepath.Join(home, "AppData", "Roaming"))

	root := newRoot()
	var out bytes.Buffer
	root.SetOut(&out)
	root.SetErr(&out)
	root.SetArgs([]string{"service", "status"})
	if err := root.Execute(); err != nil {
		t.Fatalf("service status errored on a clean machine: %v\n%s", err, out.String())
	}
	s := out.String()
	if !strings.Contains(s, "not installed") {
		t.Errorf("status on a clean machine did not say 'not installed':\n%s", s)
	}
	// The path is the honest part: the user must be told exactly which file
	// would define the service, installed or not.
	if !strings.Contains(s, "file:") || !strings.Contains(s, home) {
		t.Errorf("status did not report a definition path inside %s:\n%s", home, s)
	}
	if !strings.Contains(s, "daemon:") {
		t.Errorf("status did not report whether the daemon is running:\n%s", s)
	}
	if entries, err := os.ReadDir(home); err == nil {
		for _, e := range entries {
			if e.Name() == "Library" || e.Name() == ".config" {
				t.Errorf("status created %s — it must be read-only", e.Name())
			}
		}
	}
}

// servicePlan is the bridge between the user's config and the generated file.
// Two things it must get right: the port comes from config.json (a service that
// silently reverts to 4173 moves the dashboard out from under the user), and an
// explicit --port wins.
func TestServicePlanTakesThePortFromConfig(t *testing.T) {
	dataDir := t.TempDir()
	t.Setenv(config.EnvDataDir, dataDir)
	cfg := config.Defaults()
	cfg.Port = 4444
	if err := config.Save(dataDir, cfg); err != nil {
		t.Fatal(err)
	}

	p, dir, err := servicePlan(0, "")
	if err != nil {
		t.Fatal(err)
	}
	if dir != dataDir {
		t.Errorf("plan data dir = %q; want %q", dir, dataDir)
	}
	if p.Port != 4444 {
		t.Errorf("plan port = %d; want the configured 4444", p.Port)
	}
	if !strings.Contains(strings.Join(p.Args(), " "), "--port 4444") {
		t.Errorf("args = %v; want the configured port", p.Args())
	}

	// An explicit flag overrides config.json.
	p, _, err = servicePlan(5555, "")
	if err != nil {
		t.Fatal(err)
	}
	if p.Port != 5555 {
		t.Errorf("plan port = %d; want the --port override 5555", p.Port)
	}
}

// The data dir must be baked into the plan, or a user with CAPROCK_DATA_DIR set
// gets a second, empty database after every reboot.
func TestServicePlanCarriesTheDataDir(t *testing.T) {
	dataDir := t.TempDir()
	t.Setenv(config.EnvDataDir, dataDir)
	p, _, err := servicePlan(0, "")
	if err != nil {
		t.Fatal(err)
	}
	if p.DataDir != dataDir {
		t.Errorf("plan data dir = %q; want %q", p.DataDir, dataDir)
	}
	body, _, err := p.Render()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), "CAPROCK_DATA_DIR") {
		t.Errorf("the generated definition does not pass CAPROCK_DATA_DIR:\n%s", body)
	}
}

// The plan must run the *currently running binary* by absolute path, never a
// bare "caprock": a login agent does not inherit the shell's PATH, so a name
// resolved against $PATH (or against the agent's working directory) produces a
// service that silently fails to start at every boot.
//
// Asserting filepath.IsAbs alone would not prove this — filepath.Abs("caprock")
// is absolute too. So this pins the plan's Exe to os.Executable() itself.
func TestServicePlanRunsThisExactBinary(t *testing.T) {
	t.Setenv(config.EnvDataDir, t.TempDir())
	self, err := os.Executable()
	if err != nil {
		t.Skip("os.Executable is unavailable here")
	}
	p, _, err := servicePlan(0, "")
	if err != nil {
		t.Fatal(err)
	}
	if !filepath.IsAbs(p.Exe) {
		t.Errorf("plan exe = %q; want an absolute path", p.Exe)
	}
	wantAbs, err := filepath.Abs(self)
	if err != nil {
		t.Fatal(err)
	}
	if p.Exe != wantAbs {
		t.Errorf("plan exe = %q; want this running binary %q — a service must not depend on $PATH", p.Exe, wantAbs)
	}
}

// joinArgs is what the install output prints as "runs: …". An unquoted path
// with a space there would read as two arguments — a wrong answer to the one
// question the user asked.
func TestJoinArgsQuotesSpaces(t *testing.T) {
	got := joinArgs([]string{"up", "--hive", "/my hive/dir", "--no-open"})
	if !strings.Contains(got, `"/my hive/dir"`) {
		t.Errorf("joinArgs = %q; want the path with a space quoted", got)
	}
	if got := joinArgs([]string{"up", "--no-open"}); got != "up --no-open" {
		t.Errorf("joinArgs = %q; want no gratuitous quoting", got)
	}
}
