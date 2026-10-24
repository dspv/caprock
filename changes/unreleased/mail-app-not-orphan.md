---
kind: Fixed
---
- **resources:** Caprock resources no longer offers to stop Caprock Mail. The
  separate Mail app was taken for a Caprock command left behind because its
  process name starts with `caprock`; an app in its own bundle is never listed
  now, only the `caprock` binary itself.
