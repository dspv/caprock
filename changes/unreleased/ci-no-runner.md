---
kind: Changed
---
- **ci:** a CI job GitHub never ran — it waited for a machine, then ended with
  no step run and no runner, as hosted macOS jobs sometimes do — is no longer
  shown as a failure. The check summary says *⚠ 1 no runner* in muted amber,
  its hover says the code was not tested, and the folded CI line offers
  **Rerun** right there (a click and a confirm; it re-runs the failed jobs
  with the GitHub connection you set up). A pull request whose only
  non-passing jobs got no runner is not counted as failed and sends no *CI
  failed* notification; real failures stay red.
