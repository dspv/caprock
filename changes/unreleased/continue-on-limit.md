---
kind: Added
---
- **agents:** when a Claude Code session Caprock started hits its plan's usage
  limit, it can be continued elsewhere: on DeepSeek or Kimi as the same
  conversation, on another Claude Code sign-in as the same conversation (its
  transcript copied there, never moved), or on Codex with a summary of the
  work. `POST /v1/sessions/{id}/continue-on`; sessions carry `limit_hit`
  with the reset time; Settings can move a session automatically and bring
  it back after the reset (ADR-090). The screens come next.
- **subscriptions:** Claude Code on Kimi, on your own Kimi platform key, kept
  in the keychain like the DeepSeek key, with Moonshot's published settings
  for Claude Code.
