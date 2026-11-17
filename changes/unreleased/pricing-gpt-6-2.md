---
kind: Fixed
---
- **pricing:** Codex sessions on GPT-6.2 Astra and GPT-6.2 Sol now show a cost.
  OpenAI released both on 2026-11-17 and Codex lists them first in its
  picker, but the table had no row for them, so their turns were unpriced.
  Prices are OpenAI's list prices, read 2026-11-17: Astra $8 input, $0.40
  cached, $40 output per 1M; Sol $2, $0.10 and $10; both doubled on input
  and 1.5x on output over 272K input tokens, with a 1.05M context window.
  Turns already recorded are priced on the next start. Pricing table
  `2026-11-17.4`.
