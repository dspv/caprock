package agents

// SubagentModelEnv is the variable Claude Code reads for the model its
// subagents run on; it accepts a model alias or a full model name.
const SubagentModelEnv = "CLAUDE_CODE_SUBAGENT_MODEL"

// SubagentModels is the allowlist for SpawnRequest.SubagentModel: the three
// aliases Claude Code resolves to the current model of each family. The
// request names one of these, never a variable or a free-form value.
var SubagentModels = []string{"haiku", "sonnet", "opus"}

// ValidSubagentModel reports whether m is "" (subagents follow the session)
// or one of SubagentModels.
func ValidSubagentModel(m string) bool {
	if m == "" {
		return true
	}
	for _, v := range SubagentModels {
		if v == m {
			return true
		}
	}
	return false
}

// subagentModelFor is the model to apply for agent: only Claude Code has
// subagents, and only an allowlisted value counts.
func subagentModelFor(agent, m string) string {
	if agent != AgentClaude || m == "" || !ValidSubagentModel(m) {
		return ""
	}
	return m
}

// withSubagentModel sets CLAUDE_CODE_SUBAGENT_MODEL for a Claude Code child
// that chose a model, and leaves env untouched otherwise (a value the user's
// own shell exports stays theirs).
func withSubagentModel(env []string, agent, m string) []string {
	m = subagentModelFor(agent, m)
	if m == "" {
		return env
	}
	return withEnv(env, []string{SubagentModelEnv + "=" + m})
}
