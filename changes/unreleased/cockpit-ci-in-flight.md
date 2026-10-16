---
kind: Fixed
---
- **app:** the right panel's CI block lists only what is in flight: open pull
  requests, and the ones merged since the latest release. Released and
  closed ones are gone, so a repository that publishes no releases (a site
  that pushes straight to master) no longer fills the block with every merge.
  With nothing in flight it says so in one line, with the last release and how
  long ago it was, over the three newest merges. Ring and By OS are never
  blank: without the session deck's own PR they draw the newest pull request
  in flight, read its checks themselves, and say "Nothing in flight" when
  nothing is.
