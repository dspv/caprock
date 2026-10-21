---
kind: Fixed
---
- **telegram:** saving a new bot token, or pairing a new chat, no longer
  leaves the old *Last alert failed* under Settings → Telegram until a test
  is sent. The old outcome is forgotten at once and the line reads *Saved.
  Send a test alert to check it reaches you.* With no alert switched on, the
  section now says the bot is idle: nothing is sent and its messages are not
  read.
