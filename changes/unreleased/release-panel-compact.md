---
kind: Changed
---
- **ui:** the right panel's *Release* section reads at its own width: each
  pull request's title takes the full row and wraps to two lines instead of
  being cut beside a progress bar, with one muted line under it in plain
  words (*CI 1/3*, *CI failed*, *ready*, *merged · not released*) and its
  age. Blocked pull requests come first, marked *!*; a branch a batch pull
  request already carries shows as that pull request's *+N branches*; the
  branches without a pull request fold away by default, one line each with
  their age; the heading is the version and the last release.
