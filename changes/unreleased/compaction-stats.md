---
kind: Added
---
- **compact:** every compaction is now a stat: what it cost and what it has
  saved since, both estimated from the pricing table and marked ≈. The Agent
  panel's Context shows the latest one on one line (*32h ago · 442k → 19k ·
  cost ≈ $0.09*) with a small curve of the saving since and *saved ≈* at its
  end; the ⓘ beside *~15% stays* says what /compact does and how each figure
  is estimated. Cost and Week gain a Compactions panel: the count, cost,
  saved and net for the period. Every compaction already recorded is filled
  in once on the first start, its summary's length read back from the
  transcript. New `GET /v1/stats/compactions`; `GET
  /v1/sessions/{id}/compaction` gains `estimate` (migration 0077).
