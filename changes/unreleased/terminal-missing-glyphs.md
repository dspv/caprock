---
kind: Fixed
---
- **api:** Claude Code's footer no longer loses characters after you switch
  tabs or apps or reconnect: no more status line of lone digits or mode line
  with its words gone. The repaint that redraws a reattached terminal now waits
  for the session to draw at the narrower size before restoring its width. A
  busy Claude Code used to get both size changes as one and redraw nothing. A
  terminal that falls behind mid-session is now repainted too.
