---
kind: Added
---
- **doctor:** the orphan list now covers Codex CLIs whose session ended or
  whose parent exited, and terminals still running from an older Caprock
  install (a Homebrew `caprock pty-host` left from before a move to the app),
  shown but never ticked in Clean up. Each process shows its CPU and its
  command line, cut short with tokens and passwords hidden. The status bar
  says *3 orphans* and the doctor *Orphans: 3 · 410 MB*; `caprock doctor`
  prints the same.
