---
kind: Changed
---
- **cockpit:** the right panel's *Release* section reads as release notes:
  the stages strip always on top, the predicted version with its bump and
  why, the changelog entries in their own words grouped by kind, the batch
  pull request as one *via* line with its checks, and *Not in it yet* folded
  for pushed branches with no pull request. The entries the open batch pull
  request carries count before it merges, read from its branch as this
  machine last fetched it, so the version is predicted then too. Folded, the
  line says the next step: *0.183.1 · 2 changes · next: merge #949*. The
  pull request and agent rows are gone from it: the CI and Subagents sections
  show those.
