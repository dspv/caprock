---
kind: Fixed
---
- **tabs:** after `/clear` in an agent tab, the tab carries on with the
  conversation instead of freezing on the part before it. The terminal stays
  attached, the chat shows the earlier part above a *Context cleared — Claude
  no longer remembers the part above* line with the new part under it, typing
  works, and the session page no longer says the session has ended while it
  runs. A fork never takes the original's tab. A Caprock restart finds the
  newest part of a cleared session again.
