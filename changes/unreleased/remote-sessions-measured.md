---
kind: Fixed
---
- **ingest:** a Claude Code session whose transcript is not under
  `~/.claude/projects` as the daemon spells it — a `CLAUDE_CONFIG_DIR`, a
  home the daemon resolves differently, a path in another case on Windows —
  is measured again: the daemon follows the exact file its hooks name. A
  session a Windows PC started for another computer showed hooks and no
  transcript, so no turns, tokens or cost while it worked (#1085).
  `GET /v1/status` says where the tailer looks (`ingest.root`) and how many
  transcripts it followed (`ingest.followed`).
- **sessions:** a Claude Code session Caprock started says *Nothing measured
  yet* until its first hook, not that Caprock does not measure it.
