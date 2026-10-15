---
kind: Added
---
- **app:** the release check runs hourly instead of every six hours, and
  within five minutes of the computer waking; it is the same conditional
  request to GitHub, and nothing new is sent. Settings has its own
  **Updates** section: the switch, when Caprock last checked, and **Check
  now**. In the desktop app it adds a choice for a new version: **Ask me**
  (the card, as before) or **Update automatically**, which downloads the
  update in the background and restarts into it only when no agent is
  working or waiting on a permission prompt, you have left the app alone
  for two minutes, and nothing typed is waiting to be sent — with ten
  seconds' notice and **Not now**, and *Updated to vX · What's new*
  afterwards. Sessions and tabs come back as after any update. The update
  card also offers **Always update automatically**.
- **app:** a check for updates you ask for always answers. Nothing newer:
  a banner says *You're up to date — Caprock X is the latest · checked just
  now*, with **Close**, and goes after 8 seconds unless the pointer is on
  it. A failed check shows the error with **Retry**. The hourly background
  check stays silent when there is nothing new.
