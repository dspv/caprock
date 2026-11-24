---
kind: Changed
---
- **app:** the macOS menu bar popover is made on its first open instead of
  at start, where it was kept as a second web page whether opened or not. With the popover never opened the app uses about 46 MB
  less (188.9 → 143.3 MB at start on the bench). A first open shows a
  loading mark until the page draws.
