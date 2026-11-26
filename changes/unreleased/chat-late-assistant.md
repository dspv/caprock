---
kind: Fixed
---
- **chat:** a reply whose words come on a later transcript line than its
  first (thinking first, as Claude Code writes it) shows in an open chat even
  when the window was out of sight while it landed. The chat took the reply's
  row and the update carrying its words in one batch, dropped the update as
  already seen, and showed the prompt and the reply chips with no answer; the
  daemon's live frame for the row now carries the words as well.
