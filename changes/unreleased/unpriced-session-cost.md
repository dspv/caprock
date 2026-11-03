---
kind: Fixed
---
- **session:** a session on a model with no published price (Claude Code on
  Kimi, `kimi-k3`) no longer reads "Cost $0.00". The Cost tile, the session
  header and the Now card show "—" and "price unknown", or the priced sum
  with "+ N unpriced turns" when only some turns could be priced, and the
  cumulative cost panel counts priced turns only. The session API carries
  `stats.unpriced_turns`.
