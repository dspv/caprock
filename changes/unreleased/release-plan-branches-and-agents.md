---
kind: Added
---
- **release:** the right panel's Release section now shows what heads into
  the next release beyond merged pull requests: pushed branches with no pull
  request yet (ahead of the default branch, from the last 14 days, titled by
  their last commit, with their commits ahead and age; ones whose work is
  already on the default branch by content, as after a squash or batch
  merge, are left out) and the session's working subagents (*working ·
  12m*). The rows stand in sections with counts: *In this release*, *Pull
  requests*, *Ready* (branches) and *In progress* (agents).
