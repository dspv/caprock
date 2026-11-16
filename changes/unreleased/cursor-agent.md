---
kind: Added
---
- **cursor:** Cursor support. Caprock reads Cursor's Agent and Composer chats
  from the editor's own database, read-only, with the cost Cursor recorded per
  chat and model; a chat Cursor recorded no cost for shows its tokens and no
  price. **New agent → Cursor** starts `cursor-agent` with the model you type,
  and an ended CLI chat continues with `--resume`. `cursor-agent` chats you
  start yourself appear once you turn on Cursor's hooks on the Cost screen,
  merged into `~/.cursor/hooks.json` beside other tools' entries and removable.
  The Cost screen's new Cursor panel shows Cursor's figures by model and
  estimates how many tokens Cursor sends per request beyond what you typed,
  beside Claude Code's figure for the same model; a Cursor chat's page shows
  its own. Pricing table 2026-11-16.1 adds Cursor's Composer 2.5 models. See
  docs/cursor.md.
