---
kind: Fixed
---
- **brain:** Second Brain no longer reads sessions started at the disk root or
  in the home folder itself, where launchd and cron run scheduled `claude -p`
  jobs. They are recorded as skipped with the reason, drop out of the
  sessions waiting at once and stop using the daily token limit; folders
  under the home are read as before, and nothing already kept is deleted.
  Settings → Second Brain says so under *Never read these folders*.
