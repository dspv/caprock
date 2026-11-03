---
kind: Added
---
- **agents:** when a Claude Code session Caprock started hits its plan's usage
  limit, it can be continued elsewhere: on DeepSeek or Kimi as the same
  conversation, on another Claude Code sign-in as the same conversation (its
  transcript copied there, never moved), or on Codex with a summary of the
  work. `POST /v1/sessions/{id}/continue-on`; sessions carry `limit_hit`
  with the reset time; Settings can move a session automatically and bring
  it back after the reset (ADR-090).
- **terminal:** at the limit, one quiet line under the session's terminal
  says which window and when it reopens ("5-hour limit · back at 18:40"),
  with a small chip for each place it can go on — another Claude sign-in,
  DeepSeek or Kimi when their keys are set, Codex — and Wait. A click moves
  it; the tab follows the new session, and a note says where it went, with
  Undo.
- **settings:** *When a limit is reached*: Ask me, Continue automatically on
  an ordered list of targets, or Wait for the reset, and Back on Claude after
  the reset.
- **subscriptions:** Claude Code on Kimi, on your own Kimi platform key, kept
  in the keychain like the DeepSeek key, with Moonshot's published settings
  for Claude Code; its key field sits under DeepSeek's.
