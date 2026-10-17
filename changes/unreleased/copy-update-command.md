---
kind: Added
---
- **ui:** an agent's "update available" notice in a terminal gets a small bar
  near the bottom of that terminal — *Codex 0.162.0 available · Copy command ·
  Open a terminal · ×*. Copy puts the printed command on the clipboard, joined
  back across wrapped lines and without the "Run … to update." words; Open a
  terminal opens a plain shell tab in the session's folder and types nothing
  into it; × hides it for that agent and version. Caprock never runs the
  command. Codex's banner and Claude Code's update notices are recognised.
