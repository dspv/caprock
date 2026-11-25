---
kind: Fixed
---
- **cockpit:** a pull request the session just opened shows in the CI block's
  PRs view within seconds, as it already did in Ring. The PRs view read a
  pull request list kept up to two minutes and asked again once a minute, so
  a new PR could be missing for up to three minutes. When the session's own
  pull requests show one that list does not have, the block reads it again
  at once, once per pull request.
