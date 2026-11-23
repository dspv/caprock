---
kind: Changed
---
- **resources:** the summaries and history behind the Now screen read only the
  rows a working session added since they last looked, instead of that
  session's whole range again on every refresh. A response's prose merged
  into its turn and a hook's tool call linked to its message no longer count
  as a rewrite, and a call stored by the hook before its turn's transcript
  line is put in order without reading the session again. Every figure stays
  exactly what a fresh count gives.
