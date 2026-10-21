---
kind: Added
---
- **agents:** a chat or agent Caprock started that has no tab is ended once it
  has sat idle for 12 hours — nothing typed, drawn or recorded, and no
  permission prompt, question, queued message or working subagent waiting —
  so idle sessions no longer pile up in memory. Settings → New sessions →
  *End idle chats after*: 2 h, 12 h, 24 h or Never. The conversation stays
  listed and says *Ended after 12 h idle — continue*; opening it (or replying
  to it in Telegram) continues it from where it stopped. Never applied to a
  session with a tab, a shell, the orchestrator's workers, or a session
  Caprock did not start. Idle time is measured from the session's own
  activity, so a daemon restart does not reset it.
