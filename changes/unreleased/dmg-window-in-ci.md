---
kind: Fixed
---
- **app:** the macOS `.dmg` opens on its branded window again (in fact for the
  first time from a release): the background picture, the app and the
  Applications folder side by side, the 660×400 window. Tauri's bundler lays
  that window out with a Finder script it skips on CI, so every `.dmg`
  release.yml built since 0.97.0 opened as a plain white folder. The image is
  now made with dmgbuild, which writes the window's settings directly, and the
  release and CI checks fail without them.
