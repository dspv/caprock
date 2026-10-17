---
kind: Changed
---
- **termbuf:** terminal output no longer allocates as it scrolls through the
  256 KiB scrollback ring, in the daemon and in the pty-host alike: the ring
  is one fixed array written in a circle, and the wake-up channel is made only
  when a terminal is waiting. Measured 2026-10-18 on an M1 Pro under load
  (`BenchmarkRingWrite`, full ring, nobody waiting): a 1 KiB write went from
  5153 B and 1 allocation to none, a 16 KiB write from 77,938 B and 1
  allocation to none.
