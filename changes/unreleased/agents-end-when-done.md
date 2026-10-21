---
kind: Added
---
- **agents:** `POST /v1/agents` takes `end_when_done: true` for a new Claude
  Code or Codex session started with a prompt: once its turn finishes (Claude
  Code's Stop hook, Codex's `task_complete`) with no permission prompt,
  question, queued message or working subagent left, Caprock ends it the way
  End does. A script that starts a one-job session every half hour no longer
  leaves an idle TUI behind each time — Codex's never exits by itself, and 27
  of them had piled up in a day on one machine. Off unless asked for; never
  applied to a session started without it or not started by Caprock.
