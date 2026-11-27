package main

import (
	"bytes"
	"os"
	"strings"
	"testing"

	"github.com/dspv/caprock/internal/config"
)

// `caprock url` prints the configured port, never an assumed one: the Windows
// PC listened on 22776 and the Mac on 4173, and scripts had to read
// config.json to tell (#1095).
func TestURLCommandPrintsTheConfiguredPort(t *testing.T) {
	run := func(dir string) (string, string) {
		t.Helper()
		t.Setenv(config.EnvDataDir, dir)
		root := newRoot()
		var out, errOut bytes.Buffer
		root.SetOut(&out)
		root.SetErr(&errOut)
		root.SetArgs([]string{"url"})
		if err := root.Execute(); err != nil {
			t.Fatal(err)
		}
		return out.String(), errOut.String()
	}
	// config.json names the port.
	dir := t.TempDir()
	if err := os.WriteFile(config.ConfigPath(dir), []byte(`{"port": 22999}`), 0o600); err != nil {
		t.Fatal(err)
	}
	out, errOut := run(dir)
	if out != "http://127.0.0.1:22999\n" {
		t.Fatalf("stdout %q", out)
	}
	if !strings.Contains(errOut, "not running") {
		t.Fatalf("stderr %q", errOut)
	}
	// An install from before the port change: no config.json, a database.
	old := t.TempDir()
	if err := os.WriteFile(config.DBPath(old), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if out, _ := run(old); out != "http://127.0.0.1:4173\n" {
		t.Fatalf("legacy install: %q", out)
	}
	// A fresh install.
	if out, _ := run(t.TempDir()); out != "http://127.0.0.1:22776\n" {
		t.Fatalf("fresh install: %q", out)
	}
}

// `caprock status` with the daemon down names the address it will listen on.
func TestStatusDownNamesTheConfiguredAddress(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(config.ConfigPath(dir), []byte(`{"port": 22998}`), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv(config.EnvDataDir, dir)
	root := newRoot()
	var out bytes.Buffer
	root.SetOut(&out)
	root.SetErr(&out)
	root.SetArgs([]string{"status"})
	_ = root.Execute()
	if !strings.Contains(out.String(), "http://127.0.0.1:22998") {
		t.Fatalf("%q", out.String())
	}
}
