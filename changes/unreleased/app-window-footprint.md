---
kind: Changed
---
- **perf:** a hidden window no longer receives terminal output: after 2 s
  out of sight each terminal lets its socket go and, when shown, resumes from
  its last byte, so nothing is lost. A flooding terminal is written at most
  every 33 ms instead of on every chunk. The status strip's footprint and the
  shell list arrive as live-socket frames instead of a 10 s poll each.
  Measured in Chromium against a test daemon, 60 s each (2026-10-19,
  `docs/app-window-footprint-2026-10-19.md`): terminal frames to a hidden page
  1,218 → 0 and its CPU 1.85% → 0.62%; three tabs with one at 20 lines a
  second 28.4% → 17.9% browser CPU and 7.3 s → 4.3 s main-thread work; idle
  Home 28 → 17 requests a minute.
