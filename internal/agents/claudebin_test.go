package agents

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// Claude Code installed after the daemon started — from the setup checklist
// (ADR-099) — is found on the next check, without restarting Caprock, when
// none was found at start. A path the manager was given is kept as given.
func TestClaudeInstalledAfterStartIsFound(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home) // os.UserHomeDir on Windows
	t.Setenv("PATH", t.TempDir())
	t.Setenv("NVM_DIR", t.TempDir()) // not the developer's own nvm
	m := &Manager{claude: "claude", claudeLookAgain: true}
	if m.ClaudeAvailable() {
		t.Fatalf("found before it was installed: %q", m.binary(""))
	}
	name := "claude"
	if runtime.GOOS == "windows" {
		name = "claude.exe"
	}
	bin := filepath.Join(home, ".local", "bin", name)
	if err := os.MkdirAll(filepath.Dir(bin), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(bin, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if !m.ClaudeAvailable() || m.binary("") != bin {
		t.Fatalf("after the install: available %v, binary %q", m.ClaudeAvailable(), m.binary(""))
	}
	given := &Manager{claude: "claude"}
	if given.binary("") != "claude" {
		t.Fatalf("a given name was resolved: %q", given.binary(""))
	}
}
