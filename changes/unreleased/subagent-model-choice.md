---
kind: Added
---
- **agents:** New agent (desktop, and the phone's start sheet) asks which
  model Claude Code's subagents run on: the session's own (default), Haiku,
  Sonnet or Opus. It sets `CLAUDE_CODE_SUBAGENT_MODEL` for the session, is
  remembered per project, and shows on the session as *subagents: Haiku*. The
  Week screen adds a note when subagents ran on a pricier model than Haiku and
  the difference is a dollar or more: what they cost, and about what the same
  tokens would cost on Haiku (an estimate at list prices).
