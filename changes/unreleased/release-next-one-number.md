---
kind: Fixed
---
- **ui:** the Release panel says one next version. With open pull requests
  that would raise it, the heading names the version they make and what it
  waits for, *Next 0.197.0 · minor · waits for #1072*, over those pull
  requests' rows, and the folded line says the same number, *Ready to
  release 0.197.0 · waits for #1072*; the separate *0.197.0 once #1072
  lands* line, which read as a second number out of sync with *Next 0.196.1
  · patch*, is gone. Nothing queued, or only fixes over a patch, both are as
  before; a pull request closed drops the number back.
