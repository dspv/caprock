---
kind: Changed
---
- **tabs:** switching back to a tab is instant. The inspector and the chat
  of the last four tabs stay drawn while hidden, so a tab shown again is as
  it was left on the first frame, with no "Reading…" and no request for what
  it already held; for its first 30 s out of sight it keeps following the
  session, and after that it rests and reads only what changed when shown.
  A tab first opened draws its working tree and its calls from what this
  window last read, and pointing at a tab reads them ahead.
