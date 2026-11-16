package agents

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

// testdata/cursor-agent-2025.09.12-help.txt is the real `cursor-agent --help`
// of the CLI on the owner's machine, read 2026-11-16. Every flag the launcher
// writes must be one it lists: a flag only a newer CLI knows would make an
// older one refuse to start.
func TestCursorArgvUsesOnlyFlagsTheCLIHas(t *testing.T) {
	help := helpFlags(readTestdata(t, "cursor-agent-2025.09.12-help.txt"))
	for _, in := range []launchInput{
		{SessionID: "cap-1", Model: "sonnet-4", Mode: "bypassPermissions", Prompt: "fix the bug"},
		{SessionID: "cap-1", Resume: "cap-0", NativeResume: "5f0c7a52-1d1b-4c7e-9a43-0b7f0d1c2e3a"},
		{SessionID: "cap-1", Mode: "plan"},
	} {
		l, err := cursorLaunch(in)
		if err != nil {
			t.Fatal(err)
		}
		for _, f := range flagsOf(l.args) {
			if !help[f] {
				t.Errorf("%q is not a cursor-agent flag", f)
			}
		}
	}
}

func TestCursorArgv(t *testing.T) {
	l, err := cursorLaunch(launchInput{SessionID: "cap-1", Model: "sonnet-4", Mode: "bypassPermissions", Prompt: "fix the bug"})
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"--model", "sonnet-4", "--force", "fix the bug"}; !slices.Equal(l.args, want) || l.sessionID != "cap-1" {
		t.Errorf("new: %q %s", l.args, l.sessionID)
	}
	if !slices.Contains(l.env, "CAPROCK_CURSOR_SESSION=cap-1") {
		t.Errorf("env %q does not name the session", l.env)
	}
	// Plan has no flag every CLI knows; Cursor starts as it is.
	if l, _ := cursorLaunch(launchInput{SessionID: "s", Mode: "plan"}); len(l.args) != 0 {
		t.Errorf("plan: %q", l.args)
	}
	l, _ = cursorLaunch(launchInput{SessionID: "new", Resume: "cap-1", NativeResume: "5f0c7a52-1d1b-4c7e-9a43-0b7f0d1c2e3a", Prompt: "ignored"})
	if !slices.Equal(l.args, []string{"--resume", "5f0c7a52-1d1b-4c7e-9a43-0b7f0d1c2e3a"}) || l.sessionID != "cap-1" {
		t.Errorf("resume: %q %s", l.args, l.sessionID)
	}
	if !slices.Contains(l.env, "CAPROCK_CURSOR_SESSION=cap-1") {
		t.Errorf("a continued chat is filed under its own session: %q", l.env)
	}
	if _, err := cursorLaunch(launchInput{SessionID: "new", Resume: "old", Fork: true}); err == nil {
		t.Error("a fork was built for an agent that has none")
	}
	if got, err := NativeResume(AgentCursor, "5f0c7a52-1d1b-4c7e-9a43-0b7f0d1c2e3a", false); err != nil || !slices.Equal(got, []string{"cursor-agent", "--resume", "5f0c7a52-1d1b-4c7e-9a43-0b7f0d1c2e3a"}) {
		t.Errorf("native resume: %q %v", got, err)
	}
	// A leading dash in a prompt would read as a flag.
	if l, _ := cursorLaunch(launchInput{SessionID: "s", Prompt: "--help me"}); !slices.Equal(l.args, []string{" --help me"}) {
		t.Errorf("dash prompt: %q", l.args)
	}
}

func TestCursorSpawnsItsCLIWithTheSession(t *testing.T) {
	m, _, f := newMgr(t)
	m.bins = map[string]string{AgentCursor: "/opt/bin/cursor-agent"}
	t.Cleanup(m.Shutdown)
	ag, err := m.Spawn(context.Background(), SpawnRequest{Cwd: t.TempDir(), Agent: AgentCursor, Model: "gpt-5"})
	if err != nil {
		t.Fatal(err)
	}
	if f.lastSpec.Command != "/opt/bin/cursor-agent" || ag.Kind != AgentCursor || !slices.Contains(f.lastSpec.Args, "gpt-5") {
		t.Errorf("spec %+v kind %s", f.lastSpec, ag.Kind)
	}
	if !slices.Contains(f.lastSpec.Env, "CAPROCK_CURSOR_SESSION="+ag.SessionID) {
		t.Errorf("the CLI was not told its session: %q", f.lastSpec.Env)
	}
	if !IsSpawnable(AgentCursor) {
		t.Error("cursor is not spawnable")
	}
}

// `agent` is Cursor's CLI only when it resolves into Cursor's install; on the
// owner's machine it is Grok's.
func TestAgentIsCursorOnlyWhenItIsCursors(t *testing.T) {
	if commandName(AgentCursor) != "cursor-agent" || commandName(AgentHermes) != "hermes" {
		t.Fatal("command names")
	}
	dir := t.TempDir()
	grok := filepath.Join(dir, "grok-agent")
	if err := os.WriteFile(grok, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(grok, filepath.Join(dir, "agent")); err != nil {
		t.Skip("no symlinks here")
	}
	t.Setenv("PATH", dir)
	if p := findAgentBinary(AgentCursor); p != "" && filepath.Dir(p) == dir {
		t.Errorf("took another vendor's agent: %s", p)
	}
}
