---
kind: Fixed
---
- **cursor:** Cursor chats show their Context reading again. Cursor's newer
  builds (composer-1 and Auto chats) record only how full the window is as a
  percentage, not in tokens, and Caprock read only the tokens, so those chats
  said *no context reading yet* — or kept an older, lower reading. The
  Context tile, the cockpit's Context line and the Now card now show Cursor's
  percentage, with *Cursor doesn't record this chat's context in tokens*
  where the sizes go, and a live chat's reading follows Cursor's latest
  measure after each reply instead of staying on the one taken before it.
  Chats already imported are read again once to pick it up. A `cursor-agent`
  (CLI) chat still has no reading: its hooks carry none.
