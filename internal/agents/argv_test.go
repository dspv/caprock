package agents

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"testing"
)

// The flags below were read from the real CLIs, not from memory (memory: a
// fake binary proves nothing): codex-cli 0.160.0 `codex --help` and `codex
// resume --help`, opencode 1.15.10 `opencode --help`, on 2026-10-04. These
// tests pin that the argv is built from what those said; whether the argv is
// *right* was checked by starting each TUI with it.

func codexMgr(t *testing.T) (*Manager, *fakePTY) {
	t.Helper()
	m, _, f := newMgr(t)
	m.bins = map[string]string{AgentCodex: "/opt/bin/codex", AgentOpenCode: "/opt/bin/opencode"}
	t.Cleanup(m.Shutdown)
	return m, f
}

func TestCodexStartsItsTUIWithItsOwnFlags(t *testing.T) {
	m, f := codexMgr(t)
	cwd := t.TempDir()
	ag, err := m.Spawn(context.Background(), SpawnRequest{Cwd: cwd, Agent: AgentCodex, Model: "gpt-6-astra", PermissionMode: "acceptEdits"})
	if err != nil {
		t.Fatal(err)
	}
	if f.lastSpec.Command != "/opt/bin/codex" {
		t.Errorf("command %q", f.lastSpec.Command)
	}
	args := f.lastSpec.Args
	joined := strings.Join(args, " ")
	for _, want := range []string{"--no-daemon", "-m gpt-6-astra", "--sandbox workspace-write", "--ask-for-approval on-request"} {
		if !strings.Contains(joined, want) {
			t.Errorf("missing %q: %v", want, args)
		}
	}
	// Claude Code's spellings are not Codex's.
	for _, never := range []string{"--session-id", "--permission-mode", "--model "} {
		if strings.Contains(joined, never) {
			t.Errorf("codex was given %q: %v", never, args)
		}
	}
	if args[0] == "resume" {
		t.Errorf("a new session resumed something: %v", args)
	}
	// The trust override is a -c value naming this folder.
	i := slices.Index(args, "-c")
	if i < 0 || !strings.HasPrefix(args[i+1], "projects={") || !strings.Contains(args[i+1], `trust_level="trusted"`) {
		t.Errorf("no per-run trust override: %v", args)
	}
	if ag.Kind != AgentCodex || ag.SessionID != "fixed-session-id" {
		t.Errorf("agent %+v", ag)
	}
}

func TestCodexPermissionModes(t *testing.T) {
	for mode, want := range map[string][]string{
		"acceptEdits":       {"--sandbox", "workspace-write", "--ask-for-approval", "on-request"},
		"plan":              {"--sandbox", "read-only", "--ask-for-approval", "on-request"},
		"bypassPermissions": {"--dangerously-bypass-approvals-and-sandbox"},
		"dontAsk":           nil,
		"":                  nil,
	} {
		if got := codexPermissions(mode); !slices.Equal(got, want) {
			t.Errorf("%q → %v, want %v", mode, got, want)
		}
	}
}

// Codex has no flag that names a new thread, so resuming is the subcommand
// with the agent's own id — which, for a session Caprock started, is the
// linked one and not Caprock's.
func TestCodexResumesByTheAgentsOwnId(t *testing.T) {
	m, f := codexMgr(t)
	ag, err := m.Spawn(context.Background(), SpawnRequest{Cwd: t.TempDir(), Agent: AgentCodex, Resume: "cap-1", NativeResume: "019a-thread"})
	if err != nil {
		t.Fatal(err)
	}
	if got := f.lastSpec.Args[:2]; !slices.Equal(got, []string{"resume", "019a-thread"}) {
		t.Errorf("args %v", f.lastSpec.Args)
	}
	if ag.SessionID != "cap-1" {
		t.Errorf("a resumed session must keep its row: %q", ag.SessionID)
	}
}

func TestCodexAndOpenCodeRefuseAFork(t *testing.T) {
	m, _ := codexMgr(t)
	for _, a := range []string{AgentCodex, AgentOpenCode} {
		if _, err := m.Spawn(context.Background(), SpawnRequest{Cwd: t.TempDir(), Agent: a, Resume: "x", Fork: true}); err == nil || !strings.Contains(err.Error(), "still running") {
			t.Errorf("%s: %v", a, err)
		}
	}
}

func TestCodexTrustQuotesThePath(t *testing.T) {
	got := codexTrust(`/w/a "q" \b`)
	if !strings.HasPrefix(got, `projects={"/w/a \"q\" \\b"={trust_level="trusted"}`) {
		t.Fatalf("%s", got)
	}
	if got := tomlString("a\tb"); got != `"a\u0009b"` {
		t.Fatalf("control character: %s", got)
	}
}

func TestOpenCodeStartsItsTUIWithItsOwnFlags(t *testing.T) {
	m, f := codexMgr(t)
	ag, err := m.Spawn(context.Background(), SpawnRequest{Cwd: t.TempDir(), Agent: AgentOpenCode, Model: "opencode/big-pickle", PermissionMode: "plan"})
	if err != nil {
		t.Fatal(err)
	}
	if f.lastSpec.Command != "/opt/bin/opencode" {
		t.Errorf("command %q", f.lastSpec.Command)
	}
	joined := strings.Join(f.lastSpec.Args, " ")
	for _, want := range []string{"-m opencode/big-pickle", "--agent plan", "--port "} {
		if !strings.Contains(joined, want) {
			t.Errorf("missing %q: %v", want, f.lastSpec.Args)
		}
	}
	if ag.Port <= 0 || !strings.Contains(joined, "--port "+strconv.Itoa(ag.Port)) {
		t.Errorf("the port Caprock will listen on is not the one passed: %d %v", ag.Port, f.lastSpec.Args)
	}
	if strings.Contains(joined, "--session") {
		t.Errorf("a new session continued something: %v", f.lastSpec.Args)
	}
}

func TestOpenCodeAcceptEditsAsksBeforeCommands(t *testing.T) {
	m, f := codexMgr(t)
	if _, err := m.Spawn(context.Background(), SpawnRequest{Cwd: t.TempDir(), Agent: AgentOpenCode, PermissionMode: "acceptEdits"}); err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(f.lastSpec.Env, `OPENCODE_PERMISSION={"bash":"ask"}`) {
		t.Errorf("env lacks the permission override")
	}
	// Bypass is not claimed: OpenCode keeps asks a config override cannot
	// remove.
	l, _ := opencodeLaunch(launchInput{SessionID: "s", Mode: "bypassPermissions"})
	if len(l.env) != 0 || len(l.args) != 0 {
		t.Errorf("bypass was guessed at: %+v", l)
	}
}

func TestOpenCodeResumesWithItsOwnSessionFlag(t *testing.T) {
	m, f := codexMgr(t)
	ag, err := m.Spawn(context.Background(), SpawnRequest{Cwd: t.TempDir(), Agent: AgentOpenCode, Resume: "cap-1", NativeResume: "ses_abc"})
	if err != nil {
		t.Fatal(err)
	}
	if got := f.lastSpec.Args[:2]; !slices.Equal(got, []string{"--session", "ses_abc"}) {
		t.Errorf("args %v", f.lastSpec.Args)
	}
	// Its id is known, so no server is listened for.
	if ag.Port != 0 || slices.Contains(f.lastSpec.Args, "--port") {
		t.Errorf("a resumed session was given a port to link by: %v", f.lastSpec.Args)
	}
}

// Claude Code's folder-trust file is Claude Code's: a Codex session must not
// claim a folder in it.
func TestOnlyClaudeCodeTouchesClaudeJSON(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	m, _ := codexMgr(t)
	if _, err := m.Spawn(context.Background(), SpawnRequest{Cwd: t.TempDir(), Agent: AgentCodex}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(home, ".claude.json")); err == nil {
		t.Error("starting Codex wrote ~/.claude.json")
	}
}

func TestUnknownAgentIsRefused(t *testing.T) {
	m, _ := codexMgr(t)
	if _, err := m.Spawn(context.Background(), SpawnRequest{Cwd: t.TempDir(), Agent: "cursor"}); err == nil {
		t.Fatal("an agent Caprock has no argv for was started")
	}
}

func TestFindBinaryLooksInTheLoginPathAndInstallerDirs(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX executable bits")
	}
	login := t.TempDir()
	extra := t.TempDir()
	name := "caprock-test-agent-xyz"
	write := func(dir string) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte("#!/bin/sh\n"), 0o755); err != nil {
			t.Fatal(err)
		}
		return p
	}
	if got := findBinaryIn(name, nil, []string{extra}); got != "" {
		t.Fatalf("found %q where there is nothing", got)
	}
	want := write(extra)
	if got := findBinaryIn(name, nil, []string{extra}); got != want {
		t.Fatalf("installer dir: %q", got)
	}
	// The login shell's PATH comes before the installers' directories.
	want = write(login)
	if got := findBinaryIn(name, []string{"PATH=/nonexistent:" + login}, []string{extra}); got != want {
		t.Fatalf("login PATH: %q", got)
	}
	// A file that is not executable is not an agent.
	_ = os.Chmod(want, 0o644)
	if got := findBinaryIn(name, []string{"PATH=" + login}, nil); got != "" {
		t.Fatalf("non-executable found: %q", got)
	}
}

func TestAvailabilityFollowsTheBinary(t *testing.T) {
	m, _, _ := newMgr(t)
	defer m.Shutdown()
	dir := t.TempDir()
	p := filepath.Join(dir, "codex")
	if runtime.GOOS == "windows" {
		p += ".exe"
	}
	m.bins = map[string]string{AgentCodex: p, AgentOpenCode: "opencode"}
	if m.AgentAvailable(AgentCodex) {
		t.Fatal("available before it exists")
	}
	if err := os.WriteFile(p, []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}
	if !m.AgentAvailable(AgentCodex) {
		t.Fatal("not available once it exists")
	}
	if m.AgentAvailable(AgentOpenCode) {
		t.Fatal("a bare name that was never found counts as available")
	}
	if m.AgentAvailable("cursor") {
		t.Fatal("an agent Caprock cannot start counts as available")
	}
}

// A relay's brief is the session's first message, in each CLI's own spelling
// (claude/codex positional, opencode --prompt, gemini --prompt-interactive),
// last on the line, and never on a resume.
func TestThePromptIsTheFirstMessageInEachCLIsSpelling(t *testing.T) {
	brief := "Continue the work.\nLine two."
	cases := []struct {
		agent string
		want  []string
	}{
		{AgentClaude, []string{brief}},
		{AgentCodex, []string{brief}},
		{AgentOpenCode, []string{"--prompt", brief}},
		{AgentGemini, []string{"--prompt-interactive", brief}},
	}
	for _, c := range cases {
		l, err := builders[c.agent](launchInput{SessionID: "id", Cwd: t.TempDir(), Prompt: brief})
		if err != nil {
			t.Fatal(err)
		}
		if got := l.args[len(l.args)-len(c.want):]; !slices.Equal(got, c.want) {
			t.Errorf("%s: argv ends %q, want %q", c.agent, got, c.want)
		}
	}
	l, _ := codexLaunch(launchInput{SessionID: "id", Cwd: t.TempDir(), Resume: "r", NativeResume: "n", Prompt: brief})
	if slices.Contains(l.args, brief) {
		t.Error("a resume was given a first message")
	}
}

// A brief an editor left starting with a dash is still a prompt, not a flag.
func TestAPromptStartingWithADashIsNotAFlag(t *testing.T) {
	if got := promptArg(launchInput{Prompt: "--dangerously-bypass-approvals-and-sandbox"}); !strings.HasPrefix(got, " -") {
		t.Errorf("promptArg = %q", got)
	}
	if got := promptArg(launchInput{Prompt: "  \n"}); got != "" {
		t.Errorf("blank prompt = %q", got)
	}
}

// Through a Windows .cmd shim the brief becomes one line with % escaped,
// because cmd.exe ends the command at a newline and expands %VAR%.
func TestABriefThroughABatchShimIsOneLine(t *testing.T) {
	got := flattenForBatch("First line.\r\n\n- a.txt 100%\n")
	if got != "First line. / - a.txt 100%%" {
		t.Errorf("flattenForBatch = %q", got)
	}
	if !isBatch(`C:\npm\codex.CMD`) || isBatch("/usr/bin/codex") {
		t.Error("isBatch")
	}
}
