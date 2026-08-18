// Package orchestrator manages the Phase 2 orchestrator + worker lifecycle: it
// spawns Claude Code sessions with the hive-aware system prompt, runs the
// mailbox router on a tick, and registers agents in the hive. See
// .ai/05-orchestration.md and .ai/07-orchestrator.md.
package orchestrator

import _ "embed"

// systemPrompt is the orchestrator system prompt, kept in sync with
// .ai/07-orchestrator.md (the § SYSTEM PROMPT block). Embedded so the binary is
// self-contained; the .md file is the human-editable source of record.
//
//go:embed prompt.txt
var systemPrompt string

// SystemPrompt returns the orchestrator system prompt with the hive home path
// appended, so the session knows where its inbox/outbox and the task board live.
func SystemPrompt(hiveHome string) string {
	return systemPrompt + "\n\nYour hive home directory is: " + hiveHome + "\n"
}
