---
kind: Fixed
---
- **hermes:** an ended Hermes session can be continued in a Caprock tab
  again (`hermes chat --resume <id>`), as Codex and OpenCode ones are; it was
  refused with "Caprock continues Claude Code, Codex and OpenCode sessions."
  It is offered once the session has ended, while its folder and Hermes's
  `state.db` exist and `hermes` is installed.
- **ui:** the shortcut list no longer says ⌘W leaves the session running: it
  closes the tab or pane, an idle agent ends with its conversation kept, and
  a working one asks Keep it running or Stop it.
