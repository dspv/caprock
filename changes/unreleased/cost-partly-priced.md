---
kind: Fixed
---
- **cost:** a model priced in some chats and unpriced in others now shows its
  priced cost in the Cost and History model mix, followed by a quiet
  *+ unpriced* (for example *$153.13 + unpriced*), instead of *unpriced*
  alone, which hid money Cursor had recorded. The hover says how many tokens
  have no cost and why; they are never estimated, and the share, the order
  and the total count the priced part alone. The summary's `models` entries
  carry `unpriced_tokens`.
