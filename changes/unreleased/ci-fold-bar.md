---
kind: Changed
---
- **cockpit:** the folded CI line draws its checks as a bar, one segment per
  check coloured by its state with a failure at the left edge, followed by a
  count: *1/1 passed*, *11/13 · 2 running · 5m*, *1 failed · 12/13*. A single
  check now shows how full the run is; too many checks for a segment each fill
  the bar in proportion.
