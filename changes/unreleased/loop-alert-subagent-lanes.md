---
kind: Fixed
---
- **loop:** a subagent's edits no longer raise a loop alert on its parent. A
  subagent's tool calls arrive under the parent's session id, and the
  detector counted them in the parent's window: a parent and two subagents
  making the same edit, three each, read as nine repeats of one call. Each
  thread now counts its own — the main thread, and every subagent apart — and
  a subagent that really repeats itself still raises the alert on the session
  it works for. A hook fired inside a subagent with no `agent_id` is told
  apart by its transcript path (`…/subagents/agent-<id>.jsonl`). The Week
  card's longest loop counts the same way.
