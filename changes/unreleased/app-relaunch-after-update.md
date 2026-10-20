---
kind: Fixed
---
- **app:** after an in-app update on macOS, Caprock opens again with its
  window in front. The updated app was started as a child of the old one,
  which macOS never brought forward, so it waited behind other windows until
  a click on its Dock icon; it is now launched the way the Dock launches it.
