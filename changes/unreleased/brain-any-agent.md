---
kind: Added
---
- **brain:** 2nd Brain reads with whichever coding agent you have and are
  signed in to — Claude Code, Codex, Cursor or Gemini CLI — not only Claude
  Code. Settings → 2nd Brain → *Read with*: *Auto* (the agent you used most
  in the last 30 days, Claude Code on a tie) or one of the installed
  agents, with an optional model for each. Every read runs read-only, from
  an empty folder, with no tools. Tokens are recorded where the agent
  reports them (Claude Code, Codex, Gemini CLI) and marked *not reported*
  where it does not (Cursor), never estimated; such reads count against a
  daily reads limit (40 by default), so the daily cap still holds. When no
  agent can read — none installed, the chosen one missing, or its reads
  all failing — 2nd Brain says so in one sentence naming what is needed,
  instead of an old "last built" date, and nothing is given up meanwhile
  (ADR-103).
