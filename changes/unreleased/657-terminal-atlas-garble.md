---
kind: Fixed
---
- **app:** the terminal in front no longer turns to garbage after a long
  day of tabs. xterm's WebGL renderer shares one glyph atlas among every
  terminal, merges its pages when it fills, and after the second merge
  kept drawing from the old page's texture (the new merged page carried
  the same per-page version number as the old one): letters clipped and
  overlapped over the whole screen until font size + then −. Every
  terminal now re-sends its atlas to the GPU and redraws when a merge
  happens, and the window back in front after half a minute away does the
  same for the tab shown.
