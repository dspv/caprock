---
kind: Fixed
---
- **hooks:** the hook shim in Caprock's data folder is brought up to date every
  time Caprock starts. The desktop app never replaced it, so a shim an earlier
  Homebrew install had put there could keep running, months old, under a
  current Caprock. With no separate shim to copy, the app puts its own
  `caprock` there, which works as the shim.
- **hooks:** Caprock's own hook and status line commands in
  `~/.claude/settings.json` are repointed at this install when they run a
  `caprock` that is gone or is another copy (an uninstalled Homebrew one, for
  example). A status line or hook of your own is never touched, and the file
  is backed up first.
