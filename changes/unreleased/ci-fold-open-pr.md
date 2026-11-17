---
kind: Fixed
---
- **ci:** folded, the CI line shows the checks of the repository's open pull
  request when the session's own is already merged, instead of just
  "merged". The session's own open pull request still keeps the line, and the
  line is drawn only from a read made since the block was shown.
