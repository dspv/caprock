package agentcat

import (
	"os"
	"path/filepath"
	"testing"
)

func TestHermesEntry(t *testing.T) {
	home := t.TempDir()
	env := Env{Home: home, GOOS: "darwin"}
	if e := hermesEntry(env, false, false); e.Installed || e.Ready || e.Setup == nil || e.Setup.Reason != "not_installed" || !e.Observed {
		t.Errorf("not installed: %+v", e)
	}
	// Installed, no config: ready, with the user's own `hermes model` as the hint.
	e := hermesEntry(env, true, false)
	if !e.Ready || e.Setup == nil || e.Setup.Command != "hermes model" {
		t.Errorf("no model: %+v %+v", e, e.Setup)
	}
	write := func(body string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Join(home, ".hermes"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(home, ".hermes", "config.yaml"), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	for body, want := range map[string]bool{
		"model:\n  default: \"\"\n  provider: auto\n":          false,
		"model:\n  # default: x/y\n  provider: auto\n":         false,
		"model:\n  default: \"anthropic/claude-opus-4.6\"\n":   true,
		"model:\n  model: openrouter/some-model # chosen\n":    true,
		"model: openai/gpt-5.5\n":                              true,
		"agent:\n  default: x\nmodel:\n  provider: auto\n":     false,
		"model:\n  provider: auto\ndisplay:\n  default: tui\n": false,
	} {
		write(body)
		if got := hermesHasModel(env); got != want {
			t.Errorf("%q: has model = %v", body, got)
		}
	}
	write("model:\n  default: some/model\n")
	if e := hermesEntry(env, true, false); e.Setup != nil {
		t.Errorf("a configured model still asks: %+v", e.Setup)
	}
	if got := hermesHome(Env{Home: home, GOOS: "windows", Vars: []string{`LOCALAPPDATA=C:\L`}}); got != filepath.Join(`C:\L`, "hermes") {
		t.Errorf("windows home = %q", got)
	}
	if got := hermesHome(Env{Home: home, Vars: []string{"HERMES_HOME=/h"}}); got != "/h" {
		t.Errorf("HERMES_HOME = %q", got)
	}
}
