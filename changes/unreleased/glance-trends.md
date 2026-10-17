---
kind: Added
---
- **now:** At a glance shows which way each share is moving. Every legend
  row, Numbers table row and agent carries a small marker, the change in its
  share between the last 7 days and the 7 before (`↑ 9`, `↓ 4`, `·` under a
  point), and its hover says both shares in words. When a model's share of
  spend moved five points or more, one sentence under Where the money went
  says so. Measured shares only, no projection; `GET /v1/glance` gained
  `trend`.
