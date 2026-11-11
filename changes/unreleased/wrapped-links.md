---
kind: Fixed
---
- **ui:** a long link in a terminal opens whole on ⌘-click (Ctrl+click
  elsewhere), not cut where it wraps. Claude Code breaks a URL wider than the
  screen onto the next line itself, and each line was read as a separate
  link; the rows of one URL are now read together, whichever row you click.
