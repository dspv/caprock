---
kind: Fixed
---
- **pricing:** the Partial cost note no longer lists Cursor chats as models
  Caprock cannot price. A Cursor chat Cursor recorded no cost for is said on
  its own line, *Cursor recorded no cost*, each name with why in plain words:
  Cursor's Auto (`default`) does not say which model ran, `composer-1` and
  `code-supernova` have no per-token price Cursor publishes, and a model such
  as `claude-4-sonnet` is known — Cursor just kept no cost for that chat, and
  Caprock does not guess Cursor's bill from list prices. Those names are no
  longer offered for a "report unknown model" issue.
