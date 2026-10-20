---
kind: Fixed
---
- **app:** a terminal no longer keeps stale rows after its GPU context is
  lost (a sleep, a GPU reset, or WebKit letting a background tab's context
  go): it switches to its plain renderer in that frame instead of drawing on
  a dead canvas for three seconds, or for good when no loss was reported, and
  gets a fresh context shortly after. A lost context is also looked for when
  you come back to the tab or the window. The key hint over Claude Code's
  input box goes when the window loses focus instead of staying over the
  quick replies.
