package agents

import (
	"context"
	"slices"
	"testing"
)

// Built from Hermes Agent 0.21.6's own `hermes chat --help`, read 2026-10-15:
// `chat` is the interactive session, `-m` its model, `--yolo` the bypass,
// `-q` the first message (on a TTY it seeds the session rather than ending
// it), `--resume <id>` a continuation, and nothing names a new id or forks.
func TestHermesArgv(t *testing.T) {
	l, err := hermesLaunch(launchInput{SessionID: "cap-1", Model: "anthropic/claude-sonnet-4.6", Mode: "bypassPermissions", Prompt: "fix the bug", SystemPrompt: "not passed"})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"chat", "-m", "anthropic/claude-sonnet-4.6", "--yolo", "-q", "fix the bug"}
	if !slices.Equal(l.args, want) || l.sessionID != "cap-1" {
		t.Errorf("new: %q %s", l.args, l.sessionID)
	}
	// A mode Hermes has no counterpart for is left off rather than guessed at.
	if l, _ := hermesLaunch(launchInput{SessionID: "s", Mode: "plan"}); !slices.Equal(l.args, []string{"chat"}) {
		t.Errorf("plan: %q", l.args)
	}
	l, _ = hermesLaunch(launchInput{SessionID: "new", Resume: "cap-1", NativeResume: "20261015_093000_a1b2c3", Prompt: "ignored"})
	if !slices.Equal(l.args, []string{"chat", "--resume", "20261015_093000_a1b2c3"}) || l.sessionID != "cap-1" {
		t.Errorf("resume: %q %s", l.args, l.sessionID)
	}
	if _, err := hermesLaunch(launchInput{SessionID: "new", Resume: "old", Fork: true}); err == nil {
		t.Error("a fork was built for an agent that has none")
	}
	if got, err := NativeResume(AgentHermes, "20261015_093000_a1b2c3", false); err != nil || !slices.Equal(got, []string{"hermes", "chat", "--resume", "20261015_093000_a1b2c3"}) {
		t.Errorf("native resume: %q %v", got, err)
	}
}

func TestHermesSpawnsWithItsBinary(t *testing.T) {
	m, _, f := newMgr(t)
	m.bins = map[string]string{AgentHermes: "/opt/bin/hermes"}
	t.Cleanup(m.Shutdown)
	ag, err := m.Spawn(context.Background(), SpawnRequest{Cwd: t.TempDir(), Agent: AgentHermes})
	if err != nil {
		t.Fatal(err)
	}
	if f.lastSpec.Command != "/opt/bin/hermes" || ag.Kind != AgentHermes || !slices.Contains(f.lastSpec.Args, "chat") {
		t.Errorf("spec %+v kind %s", f.lastSpec, ag.Kind)
	}
	if !IsSpawnable(AgentHermes) {
		t.Error("hermes is not spawnable")
	}
}
