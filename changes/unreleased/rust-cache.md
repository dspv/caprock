---
kind: Changed
---
- **ci:** the release's desktop app builds start from compiled Rust
  dependencies instead of from scratch. A new master-only CI job keeps a
  Rust cache of the macOS universal build (both architectures). CI's Linux
  app build moves to ubuntu-22.04, the image the release builds the AppImage
  on, so the two share one cache. The release jobs only read master's caches
  and no longer write Go caches that no later tag could read. A stale or
  missing cache costs build time only: signing, notarization and the
  updater signatures are unchanged.
