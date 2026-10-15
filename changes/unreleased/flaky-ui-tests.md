---
kind: Fixed
---
- **ui:** the UI tests that turned PRs red at random pass every time. The
  chat test's live store dialled a socket nobody answered and flipped the
  link to *reconnecting* mid-test; the cockpit tests compared times drawn
  from the clock with fixtures stamped when the file loaded; and the app
  workspace tests handed the dashboard a summary without `savings`, so the
  Now screen crashed whenever it drew one. Tests only; nothing in the
  product changed.
