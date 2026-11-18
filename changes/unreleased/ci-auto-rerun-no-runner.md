---
kind: Added
---
- **ci:** *Rerun jobs GitHub never ran*, a switch in Settings → GitHub and
  right beside **Rerun** on a job GitHub gave no machine (*Always rerun
  these*). Off unless you turn it on. While Caprock runs, it then asks
  GitHub to re-run that run's failed jobs itself — the same request as the
  Rerun button, sent to api.github.com with your GitHub token, for your
  repositories only — when nothing else in the run failed, release runs
  included. Once per run, remembered across restarts: if GitHub gives the
  re-run no machine either, it is shown and left to you. The run then says
  *re-run by Caprock* on the folded CI line and in the list, with when and
  what on hover.
