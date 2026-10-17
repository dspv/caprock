---
kind: Changed
---
- **doctor:** stopping a listed process sends SIGTERM and then reports
  whether it is still running, instead of following up with SIGKILL on its
  own. A process that ignores the request gets **Force stop** in the panel,
  or `caprock doctor --stop <pid> --force`, as a second, separate choice.
