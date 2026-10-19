---
kind: Fixed
---
- **release:** the right panel's *Branches pushed, no PR yet* no longer lists
  branches that already shipped. A branch squashed into a batch pull request
  was still listed once master edited the same files or the release consumed
  its changelog fragment; it is now found by its commit subjects in the
  squash's message, or by its changes still standing in master's history. A
  branch already inside another open pull request's branch (a batch) is left
  out too. Each branch reads in two lines at 360px — its commit subject, then
  the branch, its commits and age with ↗ — five at a time behind *Show all
  N*, and a branch with no commit in a week waits behind *+N older*. Pull
  request titles in the right panel take two lines instead of being cut.
