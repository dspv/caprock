---
kind: Fixed
---
- **userenv:** on Windows, Git or the GitHub CLI installed with winget after
  Caprock started is found by Caprock itself, for a clone, a worktree or the
  GitHub tabs, without restarting it: the daemon adds the folders new in the
  registry's PATH to its own.
