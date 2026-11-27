---
kind: Changed
---
- **premium:** Caprock is free for one person, all of it, with no licence key.
  The daily spend cap, the pause at the plan limit, the weekly report, Ask
  Gemini and the tool drill-down's output, failure rates and hints work for
  everyone, as do any number of Claude Code and Codex sign-ins, custom agents
  added by command, talking to your agents from Telegram (reply, approve,
  deny, `/sessions`, `/new`, `/stop`, forwards, once *Let my paired chat talk
  to sessions* is on) and Second Brain. There is no Premium dialog, lock,
  *Get premium* chip or banner any more, and Settings → *Plan & licence* is
  now *Plan*, with no key field; an admin key for private modules is set with
  `caprock license set`. Caprock for Teams is the paid product. For API
  clients: `GET /v1/subscriptions` drops `licensed` and `free_per_agent`, the
  agent catalog drops `licensed` and `locked`, `GET /v1/gemini` and
  `GET /v1/window-stop` drop `licensed`, `GET /v1/tools/drill` drops `locked`
  and `teaser`, and no route answers `402`.
