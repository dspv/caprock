---
kind: Fixed
---
- **queue:** a message Caprock types into a session it started is sent, not
  left sitting in the prompt. *Tell the agent* on a loop alert could leave
  its text typed into a Codex session's composer, unsent, because the agent
  read the Enter as part of the fast run of text before it. The text now
  goes as a bracketed paste wherever the session turned paste on (Claude
  Code and Codex both do), the Enter follows on its own after a pause that
  grows with the message, and 1.5 s later Caprock reads the screen and
  presses Enter once more if the prompt still holds the text — never into a
  menu, and not once the turn has started. The same path serves the chat
  field, the phone, a delivery at the end of a turn, Send now and Telegram
  replies. The loop card now says *Sent to the agent* or *Will send when it
  finishes this turn*; Dismiss never sends.
