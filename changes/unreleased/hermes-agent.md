---
kind: Added
---
- **hermes:** Caprock sees Hermes Agent. Its sessions, prompts, replies, tool
  calls, tokens and cost are read from Hermes's own database, read-only, and
  shown beside every other agent, with a `hermes` filter and Hermes's own
  glyph. Cost is Hermes's figure, never re-priced, and the Cost screen says
  which part the provider reported and which is Hermes's estimate. Cron jobs
  and gateway chats (Telegram, Slack…) are shown apart as background runs, by
  source. Delegated subagents sit inside the session that delegated them,
  counted once. **New agent → Hermes** starts `hermes chat` in a terminal tab
  and links it to its Hermes record; with no model set, `hermes model` is
  offered as your own step. See `docs/hermes.md`.
