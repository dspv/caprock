---
kind: Added
---
- **app:** the status bar's *agent cpu … ram …* opens a popover on hover,
  focus or click: CPU and memory over the last 15 minutes or hour for the
  agent in front, all sessions and Caprock itself, each with its figure now,
  peak and average, and the sessions using the most right now, a click on one
  bringing its tab forward. The daemon keeps the samples it already takes in
  a fixed one-hour ring (`GET /v1/resources/history`): 157 KB for ten
  sessions, no new sampling.
