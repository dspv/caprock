---
kind: Changed
---
- **ui:** the top of the Agent panel (⌘I) takes about half the height it
  did and cuts nothing. One row carries the agent's own mark (a click on it
  still picks the session's face), the session's name once, the project only
  when it differs, the branch, the state and the permission mode. Burn rate
  stays big with tokens and spend on one line under it, beside a new chart of
  how many subagents worked each minute of the last hour, with how many work
  now, their types and the hour's peak; with none, the chart says so. The
  model, the context fill and the start are small chips under them.
- **api:** `GET /v1/sessions/{id}/subagents?hour=1` adds the last hour's
  subagent count a minute (`hour: {start, step_ms, counts, peak}`).
