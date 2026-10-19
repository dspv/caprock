---
kind: Fixed
---
- **ui:** AI;DR on a phone reached through access from anywhere no longer
  answers 403. The relay drops the browser's Origin and fetch metadata, and
  the tap sent no Content-Type to stand in for them; it now sends an empty
  JSON body. A 403 on AI;DR says in words that Caprock refused it.
