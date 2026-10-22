---
kind: Fixed
---
- **pricing:** a gateway's free model — an id ending in `-free` (OpenCode
  Zen, such as `deepseek-v4.1-flash-free`) or `:free` (OpenRouter) — is priced
  at $0 instead of showing as an unknown model to report. Turns already stored
  unpriced are priced on the next start. Pricing table `2026-10-22.1`. Closes
  #787.
