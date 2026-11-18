---
kind: Fixed
---
- **daemon:** the status check answers at once while the database is busy.
  Once a minute it used to work out the memory figures inside the request,
  which on a 2 GB database often took over a second, so the desktop app's
  0.8-second check gave up and logged the daemon as failing, up to 24 times
  in ten minutes. Those figures now come from a copy refreshed in the
  background, a few seconds to a minute old: under heavy dashboard reads the
  slowest status answer went from 2.2 s to 0.16 s on a copy of that database.
