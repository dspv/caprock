---
kind: Fixed
---
- **pricing:** Sessions on Gemini 4 Neon now show a cost. Google lists it at
  $3 input, $0.15 cache read and $15 output per 1M tokens at every prompt
  length, with a 1,048,576-token context window (read 2026-11-28), but the
  table had no row for it, so its turns were unpriced. Turns already recorded
  are priced on the next start. OpenAI's healthcare configurations and
  Google's Genie 4 world model, which no agent Caprock watches runs, are now
  skipped by the daily pricing check instead of keeping its issue open.
  Pricing table `2026-11-28.1`.
