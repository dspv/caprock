---
kind: Added
---
- **phone:** Fix CI and Re-run on a failing pull request, from the phone. On
  the phone home's Releases, under *PR #N CI failed* and under every other red
  pull request row, and in the session sheet's *Pull requests*: one tap asks
  once inline (*Ask to fix #N CI? Confirm Cancel*), then the failed job and its
  log go to the agent Caprock started on the branch, or a new agent starts in a
  worktree at the pull request's head; Re-run asks GitHub to run the failed
  jobs again. A paired phone with control may now read a session's pull
  requests, a pull request's runs and a failed job's log, and re-run its
  checks; Update branch stays on the computer.
