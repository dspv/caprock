---
kind: Fixed
---
- **app:** on Windows the tab keys read "Ctrl@0" and "Ctrl@1": the chip
  used the ⇧ glyph, which no font Windows draws it with carries. Off macOS
  every key now reads as the chord you press, Ctrl+Shift+1. The long
  Windows and Linux key hints no longer crowd or cut the sidebar's labels
  ("Settings", the theme's name, "Quick chat") or fill the header: a row
  shows its key while the pointer is on it, and holding Ctrl shows every
  key at once. macOS is unchanged.
