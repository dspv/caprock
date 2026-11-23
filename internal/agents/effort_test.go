package agents

import (
	"context"
	"slices"
	"strings"
	"testing"
)

// A chosen effort reaches Claude Code as `--effort <level>`, and nothing is
// passed for its default or for a level it does not take.
func TestSpawnClaudeEffortIsTheEffortFlag(t *testing.T) {
	for _, tc := range []struct{ choice, want string }{{"", ""}, {"low", "low"}, {"high", "high"}, {"xhigh", "xhigh"}, {"max", "max"}, {"ultra", ""}, {"High", ""}} {
		m, _, f := newMgr(t)
		if _, err := m.Spawn(context.Background(), SpawnRequest{Cwd: t.TempDir(), Effort: tc.choice}); err != nil {
			t.Fatal(err)
		}
		args := f.lastSpec.Args
		i := slices.Index(args, "--effort")
		got := ""
		if i >= 0 && i+1 < len(args) {
			got = args[i+1]
		}
		if got != tc.want {
			t.Errorf("choice %q: --effort %q, want %q (%v)", tc.choice, got, tc.want, args)
		}
		for _, kv := range f.lastSpec.Env {
			if strings.HasPrefix(kv, "CLAUDE_CODE_EFFORT_LEVEL=") {
				t.Errorf("choice %q: effort went into the environment too: %s", tc.choice, kv)
			}
		}
		m.Shutdown()
	}
}

// Codex takes it as a one-run config override, quoted as TOML.
func TestSpawnCodexEffortIsAConfigOverride(t *testing.T) {
	for _, tc := range []struct{ choice, want string }{{"", ""}, {"low", `model_reasoning_effort="low"`}, {"xhigh", `model_reasoning_effort="xhigh"`}, {"max", ""}} {
		m, f := codexMgr(t)
		if _, err := m.Spawn(context.Background(), SpawnRequest{Cwd: t.TempDir(), Agent: AgentCodex, Effort: tc.choice}); err != nil {
			t.Fatal(err)
		}
		got := ""
		for i, a := range f.lastSpec.Args {
			if a == "-c" && i+1 < len(f.lastSpec.Args) && strings.HasPrefix(f.lastSpec.Args[i+1], "model_reasoning_effort=") {
				got = f.lastSpec.Args[i+1]
			}
		}
		if got != tc.want {
			t.Errorf("choice %q: %q, want %q (%v)", tc.choice, got, tc.want, f.lastSpec.Args)
		}
		if slices.Contains(f.lastSpec.Args, "--effort") {
			t.Errorf("codex was given Claude Code's flag: %v", f.lastSpec.Args)
		}
	}
}

// An agent with no launch-time effort is started without one.
func TestEffortIsDroppedForAgentsWithoutOne(t *testing.T) {
	m, f := codexMgr(t)
	if _, err := m.Spawn(context.Background(), SpawnRequest{Cwd: t.TempDir(), Agent: AgentOpenCode, Effort: "high"}); err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(f.lastSpec.Args, " ")
	if strings.Contains(joined, "effort") || strings.Contains(joined, "high") {
		t.Errorf("opencode was given an effort: %v", f.lastSpec.Args)
	}
}

func TestEffortLevels(t *testing.T) {
	if got := EffortLevels(""); !slices.Equal(got, []string{"low", "medium", "high", "xhigh", "max"}) {
		t.Errorf("claude levels %v", got)
	}
	if got := EffortLevels(AgentCodex); !slices.Equal(got, []string{"low", "medium", "high", "xhigh"}) {
		t.Errorf("codex levels %v", got)
	}
	for _, a := range []string{AgentGemini, AgentOpenCode, AgentGrok, AgentHermes, AgentCursor, "custom:x"} {
		if got := EffortLevels(a); got != nil {
			t.Errorf("%s takes no effort at launch, got %v", a, got)
		}
	}
	if !ValidEffort(AgentClaude, "") || ValidEffort(AgentClaude, "ultracode") || ValidEffort(AgentCodex, "max") || !ValidEffort(AgentGemini, "anything") {
		t.Error("ValidEffort")
	}
}

// The login shell's CLAUDE_CODE_EFFORT_LEVEL outranks --effort, so a Claude
// Code start with a pick runs without it; without a pick it stays the user's.
func TestWithEffortDropsTheEnvOnlyForAPick(t *testing.T) {
	base := []string{"A=1", ClaudeEffortEnv + "=low"}
	if got := withEffort(base, AgentClaude, "high"); !slices.Equal(got, []string{"A=1"}) {
		t.Errorf("pick: %v", got)
	}
	for _, c := range []struct{ agent, e string }{{AgentClaude, ""}, {AgentClaude, "ultra"}, {AgentCodex, "high"}} {
		if got := withEffort(base, c.agent, c.e); !slices.Equal(got, base) {
			t.Errorf("%v changed env: %v", c, got)
		}
	}
}
