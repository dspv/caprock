package agents

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/dspv/caprock/internal/store"
)

// A session on a subscription (ADR-048) runs with that subscription's
// configuration directory in its environment, is trusted in that directory's
// .claude.json rather than the user's, and records the subscription.
func TestSpawnOnASubscription(t *testing.T) {
	home := trustTestHome(t)
	m, st, f := newMgr(t)
	t.Cleanup(m.Shutdown)
	profile := filepath.Join(t.TempDir(), "profiles", "ab12")
	if err := os.MkdirAll(profile, 0o700); err != nil {
		t.Fatal(err)
	}
	cwd := t.TempDir()
	ag, err := m.Spawn(context.Background(), SpawnRequest{Cwd: cwd, Subscription: "ab12", ConfigDir: profile})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(f.lastSpec.Env, "CLAUDE_CONFIG_DIR="+profile) {
		t.Errorf("env lacks the profile: %v", envWith(f.lastSpec.Env, "CLAUDE_"))
	}
	if b, err := os.ReadFile(filepath.Join(profile, ".claude.json")); err != nil || !strings.Contains(string(b), "hasTrustDialogAccepted") {
		t.Errorf("profile not trusted: %s %v", b, err)
	}
	if _, err := os.Stat(filepath.Join(home, ".claude.json")); err == nil {
		t.Error("the user's own .claude.json was written for a subscription's session")
	}
	s, err := store.GetSession(context.Background(), st.DB(), ag.SessionID)
	if err != nil || s.Subscription != "ab12" {
		t.Errorf("session subscription %q, %v", s.Subscription, err)
	}

	// Codex gets CODEX_HOME.
	m.bins = map[string]string{AgentCodex: "/opt/bin/codex"}
	if _, err := m.Spawn(context.Background(), SpawnRequest{Cwd: cwd, Agent: AgentCodex, Subscription: "cd34", ConfigDir: profile}); err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(f.lastSpec.Env, "CODEX_HOME="+profile) {
		t.Errorf("codex env: %v", envWith(f.lastSpec.Env, "CODEX_"))
	}

	// A subscription without its directory, or on an agent that has none, is refused.
	if _, err := m.Spawn(context.Background(), SpawnRequest{Cwd: cwd, Subscription: "ab12"}); err == nil {
		t.Error("a subscription with no directory was started")
	}
	m.bins[AgentGrok] = "/opt/bin/grok"
	if _, err := m.Spawn(context.Background(), SpawnRequest{Cwd: cwd, Agent: AgentGrok, Subscription: "ab12", ConfigDir: profile}); err == nil {
		t.Error("grok was started on a subscription")
	}
	// "default" is the user's own sign-in: no variable set.
	if _, err := m.Spawn(context.Background(), SpawnRequest{Cwd: cwd, Subscription: "default"}); err != nil {
		t.Fatal(err)
	}
	if len(envWith(f.lastSpec.Env, "CLAUDE_CONFIG_DIR=")) != 0 && os.Getenv("CLAUDE_CONFIG_DIR") == "" {
		t.Errorf("default set a config dir: %v", envWith(f.lastSpec.Env, "CLAUDE_CONFIG_DIR="))
	}
}

func envWith(env []string, prefix string) []string {
	var out []string
	for _, kv := range env {
		if strings.HasPrefix(kv, prefix) {
			out = append(out, kv)
		}
	}
	return out
}

// A session on an added subscription runs on that subscription's sign-in: a
// credential the login shell exports would outrank it (Claude Code's
// "Authentication precedence"; Codex's CODEX_API_KEY and CODEX_ACCESS_TOKEN),
// and CLAUDE_SECURESTORAGE_CONFIG_DIR would key the Keychain entry to another
// directory, so they are left out of its environment. A session on the user's
// own sign-in keeps the credentials, as their own terminal does. A fake
// binary proves only the environment handed over, not what the real agent
// does with it; that is from its docs and source (ADR-048). The pure
// functions are tested: the login-shell environment is cached per process.
func TestASubscriptionsEnvironmentLeavesCredentialOverridesOut(t *testing.T) {
	shell := []string{
		"PATH=/bin",
		"ANTHROPIC_API_KEY=sk-ant-shell",
		"ANTHROPIC_AUTH_TOKEN=bearer-shell",
		"CLAUDE_CODE_OAUTH_TOKEN=oauth-shell",
		"CLAUDE_CODE_USE_BEDROCK=1",
		"ANTHROPIC_PROFILE=work",
		"CLAUDE_SECURESTORAGE_CONFIG_DIR=/elsewhere",
		"CLAUDE_CONFIG_DIR=/Users/me/.claude-own",
		"CODEX_API_KEY=codex-shell",
		"CODEX_ACCESS_TOKEN=codex-token",
		"OPENAI_API_KEY=sk-openai",
	}
	has := func(env []string, name string) bool { return len(envWith(env, name+"=")) > 0 }

	claude := onSubscription(childEnv(shell), AgentClaude, "/data/profiles/ab12")
	for _, name := range []string{"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "ANTHROPIC_PROFILE", "CLAUDE_SECURESTORAGE_CONFIG_DIR"} {
		if has(claude, name) {
			t.Errorf("a subscription's Claude Code session got %s", name)
		}
	}
	if got := envWith(claude, "CLAUDE_CONFIG_DIR="); len(got) != 1 || got[0] != "CLAUDE_CONFIG_DIR=/data/profiles/ab12" {
		t.Errorf("config dir: %v", got)
	}
	if !has(claude, "PATH") {
		t.Error("PATH was lost")
	}

	codex := onSubscription(childEnv(shell), AgentCodex, "/data/profiles/cd34")
	if has(codex, "CODEX_API_KEY") || has(codex, "CODEX_ACCESS_TOKEN") {
		t.Errorf("a subscription's Codex session got an env credential: %v", envWith(codex, "CODEX_"))
	}
	if !has(codex, "OPENAI_API_KEY") {
		t.Error("OPENAI_API_KEY was dropped; Codex does not sign in with it and a session's tools may want it")
	}
	if !slices.Contains(codex, "CODEX_HOME=/data/profiles/cd34") {
		t.Errorf("codex home: %v", envWith(codex, "CODEX_HOME"))
	}

	// The user's own sign-in keeps the shell's credentials, as their own
	// terminal does; the Keychain redirect is a nesting marker and goes from
	// every session and shell tab.
	own := childEnv(shell)
	if !has(own, "ANTHROPIC_API_KEY") || !has(own, "CODEX_API_KEY") {
		t.Error("the own sign-in's environment lost the shell's credentials")
	}
	if has(own, "CLAUDE_SECURESTORAGE_CONFIG_DIR") {
		t.Error("CLAUDE_SECURESTORAGE_CONFIG_DIR reached a session")
	}
}
