---
kind: Changed
---
- **ui:** the app window uses less memory with terminal tabs left in the
  background. A tab out of sight for five minutes now gives its terminal's
  GPU context back, and every closed or replaced terminal gives its context
  back at once instead of when the page next cleans up. Measured in the app
  with eight terminal tabs, a long chat and the Dashboard open, after 25
  minutes: the window's graphics memory went from 125 to 80 MB and the whole
  app from 478 to 432 MB. Coming back to a tab looks as it did: the terminal
  is drawn in the frame it appears in.
