---
kind: Changed
---
- **ui:** the right panel's CI line is drawn the moment you switch to a tab,
  from what was last read for that repository (muted, with its age), while
  it is read again; it used to wait for the daemon to compose the pull
  request's checks for that session, seconds and up to 15 s when measured.
  The daemon answers such a first ask at once from the pull request it
  already keeps. Folded, the CI line's check summary shortens in a narrow
  panel instead of running past its edge.
- **ui:** folded, the Release section now says where the release is —
  *Nothing new since v1.4.0*, *1.5.0 · 5 changes waiting · PR #40 green*,
  *1.5.0 · release PR #42 · CI running*, *1.5.0 · building · 12 of 23
  files*, *v1.5.0 out · 5 min ago* — and unfolded it opens on one stages
  strip, *Merged ─ Release PR ─ Tagged ─ Building ─ Published*, the current
  stage marked.
- **ui:** the folded Changes row of a clean worktree says *nothing to
  commit*, without a *Review and commit* action that had nothing to review.
