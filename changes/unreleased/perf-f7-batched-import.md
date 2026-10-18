---
kind: Changed
---
- **perf(rollup):** importing history writes many events per transaction
  instead of one. The Claude transcript reader and the Codex importer commit
  up to 512 events or 50 ms at a time, with a transcript's read position saved
  in the same transaction, so a failed batch is read again and nothing is lost
  or counted twice. Live hook events keep their own transaction and are let in
  as soon as they wait. Every recorded event also stopped starting four or five
  short-lived goroutines inside the database layer. Measured 2026-10-18 on an
  M1 Pro, importing a synthetic 178,000-event history: 149–150 s and 152–160 s
  of CPU before, 101 s and 83–84 s after; the daemon under a working load went
  from 12.8% of one core to 11.6–11.9%.
