---
kind: Added
---
- **machines:** *Send secrets* on a linked computer's page: tick the GitHub
  token Caprock keeps, the DeepSeek key or the Kimi key and press Send. They
  travel only inside the computer's end-to-end encrypted link (the relay sees
  ciphertext), are written straight into that computer's secret store, and
  appear there by name under the computer that sent them, never as values.
  No SSH needed to set a second computer's keys (#1095, ADR-107).
