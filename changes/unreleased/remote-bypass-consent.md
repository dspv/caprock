---
kind: Fixed
---
- **machines:** New agent on another computer asks that computer whether
  Claude Code's one-time bypass warning was accepted there before the first
  start, and shows the warning with **Accept and start**, which records it
  there and starts. Before, a start in Bypass on a computer that had not
  accepted it could end a few seconds later on Claude Code's own warning,
  with nothing said (#1086).
- **agents:** a start that ends in its first seconds is never silent: a
  session started on another computer raises a note with the agent, the code,
  its last line and what it usually means (Claude Code's bypass warning
  included), with a link to the session. A terminal's focus report or the
  first message Caprock types no longer hide such an exit from the session's
  own tab.
