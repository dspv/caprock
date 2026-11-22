---
kind: Fixed
---
- **resources:** Caprock does much less database work while a private module
  or the Now screen is open. When nothing was written since the module last
  asked, its document list now answers "unchanged" without reading anything,
  instead of reading the whole collection again several times a second. And
  while agents work, the kept per-session figures behind the Now screen
  catch up on what moved at most once every 15 seconds instead of on every
  ask, so today's cost and tokens can be up to 15 seconds behind.
