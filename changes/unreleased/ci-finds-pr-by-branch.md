---
kind: Fixed
---
- **deck:** the right panel's CI and PRs now also find a pull request by the
  branch the session pushed, so CI no longer sticks on an older pull request
  when the new one was opened by a script or without the agent running
  `gh pr` itself.
