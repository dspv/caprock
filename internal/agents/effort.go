package agents

import "strings"

// The reasoning effort a session starts at, for the agents whose CLI takes
// one at launch. Each list is the agent's own, from its own documentation:
//
//   - Claude Code: `--effort <level>`, "Options: low, medium, high, xhigh,
//     max, or ultracode. Available levels depend on the model … overrides the
//     modelSettings and effortLevel settings for this session and doesn't
//     persist" (code.claude.com/docs/en/cli-reference, read 2026-11-23).
//     `ultracode` needs Claude Code v2.1.203 or later and turns on a workflow
//     besides the effort, so it is not offered. The five are also the levels
//     its hooks report (hookd.EffortLevel).
//   - Codex: the `model_reasoning_effort` config key, set for one run with
//     `-c key=value` as the trust override already is (codexLaunch). Its
//     reference names "low, medium, high, xhigh, max, or ultra" and adds that
//     "available levels depend on the model and client"
//     (learn.chatgpt.com/docs/config-file/config-reference, read
//     2026-11-23); the four every current Codex model advertises are
//     offered.
//
// Gemini CLI, OpenCode, Grok, Hermes and Cursor take no effort at launch and
// get none: the field is left off their command line rather than guessed at.
var effortLevels = map[string][]string{
	AgentClaude: {"low", "medium", "high", "xhigh", "max"},
	AgentCodex:  {"low", "medium", "high", "xhigh"},
}

// EffortLevels is the efforts agent takes at launch, lowest first; nil for
// an agent that takes none.
func EffortLevels(agent string) []string {
	if agent == "" {
		agent = AgentClaude
	}
	return append([]string(nil), effortLevels[agent]...)
}

// ValidEffort reports whether e is "" (the agent's own default) or one of
// the efforts agent takes at launch. Any value is valid for an agent that
// takes none, since it is dropped there.
func ValidEffort(agent, e string) bool {
	if e == "" {
		return true
	}
	if agent == "" {
		agent = AgentClaude
	}
	levels, ok := effortLevels[agent]
	if !ok {
		return true
	}
	for _, l := range levels {
		if l == e {
			return true
		}
	}
	return false
}

// ClaudeEffortEnv is the variable Claude Code reads its effort from first,
// over --effort (code.claude.com/docs/en/model-config, "Adjust effort
// level", read 2026-11-23).
const ClaudeEffortEnv = "CLAUDE_CODE_EFFORT_LEVEL"

// withEffort is env for a Claude Code child started with an effort: the
// login shell's CLAUDE_CODE_EFFORT_LEVEL would outrank the --effort the user
// just picked, so the child runs without it. Without a pick, or for another
// agent, env is untouched.
func withEffort(env []string, agent, effort string) []string {
	if agent != AgentClaude || effortFor(agent, effort) == "" {
		return env
	}
	out := env[:0:0]
	for _, kv := range env {
		if strings.HasPrefix(kv, ClaudeEffortEnv+"=") {
			continue
		}
		out = append(out, kv)
	}
	return out
}

// effortFor is the effort to pass agent: e when it is one of its levels,
// else "".
func effortFor(agent, e string) string {
	if e == "" || len(effortLevels[agent]) == 0 || !ValidEffort(agent, e) {
		return ""
	}
	return e
}
