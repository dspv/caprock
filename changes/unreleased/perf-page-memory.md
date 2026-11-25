---
kind: Changed
---
- **app:** a terminal tab out of sight for 30 seconds now packs its older
  scrollback into a compact form and unpacks it, exactly as it was, the
  moment the tab is shown again. xterm keeps every line at the terminal's
  full width, about 2 KB a line in the app's web view, so each tab full of
  output held about 20 MB while hidden. Packed, eight full tabs took the page
  from about 375 MB to about 265 MB in a WebKit measurement. Switching tabs
  is as fast as before and nothing in the scrollback is lost; a tab hidden
  ten minutes still keeps its last 1,000 lines, as before.
