package api

import (
	"strings"

	"github.com/dspv/caprock/internal/agents"
)

// effortRefusal says why a spawn request's `effort` cannot be used, or "".
// It is a string, and for an agent that takes an effort at launch one of its
// levels (agents.EffortLevels); "" or absent is the agent's own default. For
// an agent that takes none it is dropped at launch, like a permission mode
// the agent has no word for.
func effortRefusal(req map[string]any) string {
	v, ok := req["effort"]
	if !ok || v == nil {
		return ""
	}
	e, isStr := v.(string)
	if !isStr {
		return "effort is a string"
	}
	agent, _ := req["agent"].(string)
	if agents.ValidEffort(agent, e) {
		return ""
	}
	if agent == "" {
		agent = agents.AgentClaude
	}
	return "effort for " + agent + " is one of " + strings.Join(agents.EffortLevels(agent), ", ") + ", or absent for its own default"
}
