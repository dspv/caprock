package api

import "strings"

// endWhenDoneRefusal checks `end_when_done` on POST /v1/agents
// (03-contracts.md): a boolean, and when true, a new Claude Code or Codex
// session with a prompt — the two agents whose turn end Caprock reads (the
// Stop hook, Codex's task_complete), and a job for the turn to finish. ""
// when the request may go ahead.
func endWhenDoneRefusal(req map[string]any) string {
	v, ok := req["end_when_done"]
	if !ok || v == nil {
		return ""
	}
	on, isBool := v.(bool)
	if !isBool {
		return "end_when_done is true or false"
	}
	if !on {
		return ""
	}
	if agent, _ := req["agent"].(string); agent != "" && agent != "claude" && agent != "codex" {
		return "end_when_done is for Claude Code and Codex sessions: only their turn end is read"
	}
	if cmd, _ := req["command"].(string); cmd != "" {
		return "end_when_done is not for a command"
	}
	if resume, _ := req["resume"].(string); resume != "" {
		return "end_when_done needs a new session, not a continued one"
	}
	if prompt, _ := req["prompt"].(string); strings.TrimSpace(prompt) == "" {
		return "end_when_done needs a prompt: the session ends when its turn on it finishes"
	}
	return ""
}
