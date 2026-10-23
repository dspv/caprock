---
kind: Fixed
---
- **release:** a stray `ui/node_modules` link committed in 0.154.0 stopped
  that release from building; it is removed, and `.gitignore` now ignores
  `node_modules` whether it is a folder or a link. 0.154.0 was tagged but
  never published, so this release carries everything listed for it.
