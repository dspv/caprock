---
kind: Fixed
---
- **codex:** the New agent dialog offers only the Codex models your sign-in
  can run, as Codex's own picker does: on an API key, models Codex marks as
  not available in the API are left out; on a ChatGPT account, a model the
  catalog says your plan does not include is left out, instead of failing at
  start with "The model is not supported when using Codex with a ChatGPT
  account". When Codex's files cannot tell, the model stays listed.
