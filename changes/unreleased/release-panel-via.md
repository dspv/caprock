---
kind: Fixed
---
- **release:** the right panel's Release section takes only a release pull
  request (`chore/release-X.Y.Z`) or a pull request marked as a batch
  (`batch/…`) as the one the release goes out *via*; an ordinary open
  feature pull request no longer adds its changelog entry to the next
  release, bumps the version or shows as *via #N* — it stays under *Not in
  it yet*. While the default branch's checks run or failed after a merge,
  the section says *master checks running · 12 of 17* or *master checks
  failed* instead of *Ready to release · not started*.
