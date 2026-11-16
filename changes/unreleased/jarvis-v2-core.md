---
kind: Added
---
- **jarvis:** a question an agent asks in a session Caprock started can be
  answered from Jarvis in one tap: the digest carries the dialog's options
  with the recommended one marked, and `POST /v1/jarvis/answer` presses the
  option (or types an answer on its Other row) with the keys Claude Code
  itself reads, only after checking the dialog is still the one on the
  screen (ADR-096).
- **jarvis:** Handled for you: a log of what Caprock did on its own — a
  session moved at its usage limit (with Undo) and moved back, a session
  resumed after its limit reset, ended when done or idle, the morning
  summary sent — at `GET /v1/jarvis/handled` and as a live `jarvis` frame;
  the digest counts today's.
- **limits:** a session Caprock started that a usage limit stopped is sent
  "continue" once the limit has reset, through its message queue as
  Jarvis's Continue sends it. On by default; `limit_auto_resume` in
  settings switches it off.
