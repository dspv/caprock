---
kind: Added
---
- **agents:** Effort at start, beside Model, in the New session dialog and in
  New agent on another computer, for Claude Code (`--effort`) and Codex
  (`model_reasoning_effort`). The level the agent would use on its own is
  pre-selected and marked "default", read from its settings on the computer it
  runs on, and moves with the model; keeping it passes nothing. A different
  pick is passed for that session only and remembered per agent.
