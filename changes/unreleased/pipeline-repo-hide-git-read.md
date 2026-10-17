---
kind: Fixed
---
- **projects:** the Repos section no longer says "git could not be read" for a
  busy repository. Its one `git log --all --shortstat` over 14 days took 12 s
  on a checkout with 961 refs and 1,048 recent commits (measured 2026-10-17),
  past the 5 s git timeout, and the failure was kept for 10 minutes. Commits are
  now listed without diffs, which stays fast, and each commit's lines are
  counted once, kept, and diffed in batches under their own budget; when it
  runs out the row keeps its commits, marks the lines `…` and goes on counting
  a minute later.
