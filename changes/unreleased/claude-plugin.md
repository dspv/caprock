---
kind: Added
---
- **plugin:** Caprock is a Claude Code plugin. `claude plugin marketplace add
  dspv/caprock`, then `claude plugin install caprock@caprock`, adds the
  read-only `caprock mcp` server for every project. Its launcher finds
  `caprock` even when the desktop app put none on your `PATH`, and when
  Caprock is not installed it says so, with the install link, instead of a
  bare "failed". It downloads and sends nothing.
