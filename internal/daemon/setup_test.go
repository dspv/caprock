package daemon

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/readiness"
)

// The sign-in is read from what each agent wrote, by presence: Claude Code's
// oauthAccount (missing without it), Codex's auth.json (unknown without it:
// it may use the keyring), a Caprock subscription's folder, or a credential
// the login shell exports. The home is passed in, never the real one.
func TestSignInState(t *testing.T) {
	home, data := t.TempDir(), t.TempDir()
	cfg := config.Config{}
	if got := signInState("claude", home, nil, data, cfg); got != readiness.Missing {
		t.Fatalf("claude, nothing: %s", got)
	}
	if got := signInState("codex", home, nil, data, cfg); got != readiness.Unknown {
		t.Fatalf("codex, nothing: %s", got)
	}
	if got := signInState("claude", home, []string{"ANTHROPIC_API_KEY=sk"}, data, cfg); got != readiness.OK {
		t.Fatalf("claude, a key in the environment: %s", got)
	}
	write := func(p, s string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(s), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	// A subscription's own folder counts.
	cfg.Subscriptions = []config.Subscription{{ID: "work", Label: "Work", Agent: "codex"}}
	write(filepath.Join(data, "profiles", "work", "auth.json"), `{}`)
	if got := signInState("codex", home, nil, data, cfg); got != readiness.OK {
		t.Fatalf("codex, a subscription signed in: %s", got)
	}
	write(filepath.Join(home, ".claude.json"), `{"oauthAccount":{"emailAddress":"a@example.com"}}`)
	if got := signInState("claude", home, nil, data, cfg); got != readiness.OK {
		t.Fatalf("claude, signed in: %s", got)
	}
}

// An agent's switch is kept in config.json, a choice per agent, and nothing
// else is written: a restart reads the same switches.
func TestAgentSwitchIsKept(t *testing.T) {
	data := t.TempDir()
	d := &Daemon{}
	d.opt.DataDir = data
	a := &setupAdapter{d: d}
	before := d.config()
	if err := a.SetAgentSwitch("codex", true); err != nil {
		t.Fatal(err)
	}
	if err := a.SetAgentSwitch("claude", false); err != nil {
		t.Fatal(err)
	}
	if before.SetupAgents != nil {
		t.Fatal("a copy handed out earlier was written to")
	}
	got, err := config.Load(data)
	if err != nil {
		t.Fatal(err)
	}
	if !got.SetupAgents["codex"] || got.SetupAgents["claude"] || len(got.SetupAgents) != 2 {
		t.Fatalf("kept %v", got.SetupAgents)
	}
	if readiness.AgentOn("claude", true, got.SetupAgents) || !readiness.AgentOn("codex", false, got.SetupAgents) {
		t.Fatal("the kept choice does not win over the default")
	}
}
