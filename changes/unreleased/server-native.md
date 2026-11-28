---
kind: Added
---
- **server:** a server New server sets up now has a headless Chromium for
  the agents (the distribution's, or Playwright's headless shell on Ubuntu),
  and the script checks that Claude Code and Codex run once installed. It
  assumes a blank server and installs every tool it uses. Every supported
  system is tested end to end against the same list: the agents, Git,
  Node.js and the browser present, the server linked, its service running
  with nobody logged in, no inbound port open, automatic security updates
  on, and the same Caprock version as your laptop's.
