---
kind: Fixed
---
- **app:** a new release shows within minutes. The release check is due
  every 15 minutes (it was hourly, so a release could sit unannounced for
  most of an hour), and when you come back to the window Caprock checks
  again if the last check is ten minutes old. Never more than one check per
  ten minutes unless you ask; still one conditional request to GitHub, and
  only while Settings → Updates allows it.
- **app:** the answer to a check is at the bottom right, beside the
  version, where you look for it: *Checking for updates…*, *Caprock is up
  to date* for a few seconds, *Couldn't check for updates* with **Retry**,
  or **Update to vX — Restart** as an amber pill. The banner at the top
  centre is gone from the app.
