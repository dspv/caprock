---
kind: Added
---
- **cli:** `caprock url` prints the dashboard's local address on the port
  this computer uses (22776, or 4173 on an older install), so a script runs
  `curl "$(caprock url)/v1/status"` anywhere; `caprock status` names the
  address while the daemon is down too.
