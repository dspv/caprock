---
kind: Added
---
- **app:** the in-app browser is back as a beta, off until you turn it on
  (Settings → In-app browser). *New browser tab* (File menu, ⌘K, the +
  menu) opens a tab after your agents with the cursor in its address box;
  plain words search DuckDuckGo, or the engine you pick. A page stays
  exactly where it was while you work elsewhere, a link that opens a new
  window opens another tab, ⌥← ⌥→ (Ctrl+PageUp/PageDown on Windows and
  Linux) step between tabs, and when an agent starts waiting on you a strip
  names it and a playing video pauses. ⌘-click still opens your default
  browser. Each page now runs in a window of its own rather than inside
  Caprock's window, which is what crashed the app on macOS 27 and lost
  drops in 0.124.0; a page is never closed while it is busy.
