---
kind: Fixed
---
- **ui:** the UI tests that turned PRs red at random pass every time. The
  chat test's live store dialled a socket nobody answered and flipped the
  link to *reconnecting* mid-test; the cockpit tests compared times drawn
  from the clock with fixtures stamped when the file loaded; the app
  workspace tests handed the dashboard a summary without `savings`, so the
  Now screen crashed whenever it drew one; and the first test to open the
  lazily loaded dashboard paid for transforming it inside its own 5 s, then
  asked for its links before they had drawn. Tests only; nothing in the
  product changed.
