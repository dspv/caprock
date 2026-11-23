---
kind: Fixed
---
- **cockpit:** Fix CI shows on any open pull request whose checks failed, not only
  the ones the session recorded: a pull request the lead session opened from a
  subagent's branch had its red bar and cost in the CI list but no Fix CI
  anywhere. Its row now reads its checks and offers Fix CI (the failed job and
  its log go to the session, as before), and folded, a failing pull request of
  the repository leads the line over the session's own green one.
