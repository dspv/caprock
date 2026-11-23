---
kind: Fixed
---
- **app:** the *Restart here* strip now comes when Claude Code's voice
  failure was already on screen as the page loaded, as it is after the app
  updates with the tab open. Claude Code shows the failure in its footer
  and writes nothing after it; the terminal replayed that screen before the
  page knew the session was one Caprock started, and the strip waited for
  a next write that never came. The pane now looks at the screen as it
  stands once it knows, and asks the daemon's platform again if the first
  ask failed.
