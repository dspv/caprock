---
kind: Added
---
- **app:** choose the browser a terminal link opens in. ⌘-click (Ctrl+click
  on Windows and Linux) still opens the default browser; ⇧⌘-click
  (Ctrl+Shift+click) opens a small chooser at the pointer with the browsers
  installed on this machine, the default first, and *Copy link*. Arrows move,
  Enter picks, Esc closes. The link's hover hint names both clicks, and both
  are in the shortcuts list. The daemon finds the browsers from what the OS
  says handles web links (LaunchServices on macOS, the registry on Windows,
  desktop entries on Linux) and answers only this machine
  (`GET /v1/browsers`, `POST /v1/browsers/open`).
