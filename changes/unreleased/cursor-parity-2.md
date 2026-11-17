---
kind: Added
---
- **cursor:** a Cursor chat's turns now end the way a Claude Code session's
  do, so Now and the phone say "done" or "waiting for you" from what Cursor
  wrote last instead of going by the clock. Each turn's end keeps how long it
  ran and how long the model thought, where Cursor timed it.
- **cursor:** the summaries Cursor writes when a chat runs out of room are
  recorded as compactions, with the context before and after where Cursor
  measured them. They count in the Context look and the typical share a
  compaction keeps; they carry no cost, which Cursor does not record.
- **cursor:** chats from Cursor's older format (spring 2025) now show their
  prompts, replies and tool calls, not only their cost.
- **cursor:** the mode Cursor recorded (plan, ask, auto-run) shows on the
  session's mode chip, and whether you accepted or rejected a call is kept
  with its result.
- **cursor:** with Cursor's hooks on, a `cursor-agent` chat also records its
  start and end, its subagents, each shell command's output (so its pull
  requests and pushed branches are found), file edits and how long each tool
  ran. The added hooks only observe; press *Turn on Cursor hooks* again to
  add them to an earlier install.
