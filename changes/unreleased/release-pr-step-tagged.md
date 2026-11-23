---
kind: Fixed
---
- **release:** a tagged release no longer draws its *Release PR* step as not
  known. The release pull request is found by its head branch
  (`chore/release-x.y.z`) as well as its title, and once the version is tagged
  the step and its CI are done, with no number when none listed is it.
