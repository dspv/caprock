---
kind: Added
---
- **sessions:** resume after an API error. When Claude Code gives up on an
  overloaded or failing API call (after its own "retrying… attempt N/10") in
  a session Caprock started, Caprock types "continue" for it — a minute
  later, then five, then fifteen, three tries at most — once the session
  sits at its prompt. It stops as soon as the session goes on or you type,
  and never retries a usage limit, a sign-in, billing or a request that is
  too long. A line under the terminal says which try it was, that it went
  on, or that Caprock gave up; each "continue" is marked in the chat; the
  failed turn's notification is held while Caprock handles it, and the
  give-up's says so (through the notifications and Telegram alerts you
  already have on). Settings → After an API error turns it off; it is on by
  default.
