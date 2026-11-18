---
kind: Fixed
---
- **app:** an update no longer opens a stray *Caprock Mail* tab in the
  browser. The Mail window reloads while the daemon restarts, and with no
  daemon running the app took its own page for a link and handed it to the
  browser; a page on the daemon's address is now refused quietly until the
  daemon is back.
