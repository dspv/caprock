---
kind: Fixed
---
- **cost:** the cache savings figure ("input cost cut by cache" on Cost and
  History, the status line's `cache −N%`) weighs each model's cache at that
  model's own prices. Claude Opus 5.5 and Sonnet 5.5 read their cache at 0.05x
  of input, not the 0.10x every model was weighed at, so on those models the
  figure understated what the cache saved. A model with no pricing row keeps
  the old 0.10/1.25 weights. Costs were already right; only the savings
  figure changes (#1113).
