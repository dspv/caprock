---
kind: Added
---
- **telegram:** one Telegram bot for all your computers. A computer with no
  bot of its own can send its alerts and questions through the bot of a
  computer it is linked to (Settings → Telegram → *Send through <name>*):
  each message names the computer it came from, and Approve, Deny, Mute and
  replies go back to that computer, which acts on them by its own settings.
  While the computer with the bot is offline, messages wait on the sender
  (at most 200, up to a day) and Settings says so; *Make this computer the
  holder* moves the bot, its chat and where it stopped reading, with no new
  bot or pairing (issue #1100).
