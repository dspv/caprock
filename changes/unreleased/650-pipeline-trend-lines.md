---
kind: Added
---
- **pipeline:** every figure on the Pipeline page — and the five on Home —
  shows its last 14 days as a small line, with today set against them
  underneath: *usual*, *above usual +38%*, *below usual −30%*. In flight,
  throughput, the CI median, opened → merged, merged → released and the
  agent cost each get one; green where today is the better side (a shorter
  CI run or merge, more merges), amber the worse, muted for the open count
  and the cost. Running totals compare today so far with earlier days at
  the same hour; a day with nothing to measure is a gap, not a zero; with
  fewer than three earlier days of data it says *not enough history*.
  Hover a day for its value, or the word for what it is compared with.
  Counted from what the Pipeline already reads: no new GitHub request.
