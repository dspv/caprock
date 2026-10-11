package agents

import (
	"context"
	"slices"
	"strings"
	"testing"
)

// `claude --help` (2.1.296): `--add-dir <directories...>`, a variadic
// option. Its parser keeps taking words after `--add-dir a` until the next
// option, so a first message passed last would become a directory; the `=`
// spelling takes one value. Every directory is spelled that way, and the
// prompt stays the last word on its own.
func TestClaudeAddDirNeverSwallowsThePrompt(t *testing.T) {
	l, err := claudeLaunch(launchInput{SessionID: "s", AddDirs: []string{"/data/paste"}, RepoDirs: []string{"/work/api", "/work/web"}, Prompt: "read both repositories"})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"--add-dir=/data/paste", "--add-dir=/work/api", "--add-dir=/work/web"} {
		if !slices.Contains(l.args, want) {
			t.Errorf("argv %q lacks %q", l.args, want)
		}
	}
	if slices.Contains(l.args, "--add-dir") {
		t.Errorf("argv %q has a bare --add-dir, which would take the prompt as a directory", l.args)
	}
	if l.args[len(l.args)-1] != "read both repositories" {
		t.Errorf("argv %q: the prompt is not last", l.args)
	}
}

// A session started in a multi-repo project gets the project's other
// repositories (ADR-055): Claude Code and Codex as --add-dir, Gemini as
// --include-directories; OpenCode and Grok have no such flag.
func TestOtherRepositoriesReachEachAgentByItsOwnFlag(t *testing.T) {
	in := launchInput{SessionID: "s", Cwd: "/work", RepoDirs: []string{"/work/api", "/other/web"}}
	cases := map[string][]string{
		AgentClaude: {"--add-dir=/work/api", "--add-dir=/other/web"},
		AgentCodex:  {"--add-dir /work/api", "--add-dir /other/web"},
		AgentGemini: {"--include-directories=/work/api", "--include-directories=/other/web"},
	}
	for agent, wants := range cases {
		l, err := builders[agent](in)
		if err != nil {
			t.Fatal(agent, err)
		}
		joined := strings.Join(l.args, " ")
		for _, w := range wants {
			if !strings.Contains(joined, w) {
				t.Errorf("%s: argv %q lacks %q", agent, l.args, w)
			}
		}
	}
	for _, agent := range []string{AgentOpenCode, AgentGrok} {
		l, err := builders[agent](in)
		if err != nil {
			t.Fatal(agent, err)
		}
		if strings.Contains(strings.Join(l.args, " "), "/work/api") {
			t.Errorf("%s: argv %q names a repository it has no flag for", agent, l.args)
		}
	}
}

// The manager asks the projects service for the other repositories of the
// folder the session starts in.
func TestSpawnPassesTheProjectsOtherRepositories(t *testing.T) {
	m, _, f := newMgr(t)
	t.Cleanup(m.Shutdown)
	cwd := t.TempDir()
	var asked string
	m.ProjectRepos = func(dir string) []string { asked = dir; return []string{"/work/web"} }
	if _, err := m.Spawn(context.Background(), SpawnRequest{Cwd: cwd}); err != nil {
		t.Fatal(err)
	}
	if asked != cwd {
		t.Errorf("asked for %q, want the session's folder %q", asked, cwd)
	}
	if !slices.Contains(f.lastSpec.Args, "--add-dir=/work/web") {
		t.Errorf("argv %q lacks the other repository", f.lastSpec.Args)
	}
}
