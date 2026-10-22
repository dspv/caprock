---
kind: Fixed
---
- **app:** dragging a file from iCloud Drive onto the window no longer
  closes the app. macOS hands over such a file in a way the window's drag
  code did not expect, and the app quit on the spot (0.141.0 to 0.147.0).
  Every file is now passed on as it is, whatever its name or where it lives.
  If the app ever stops on an error again, the reason is written to
  `app.log` in Caprock's data folder.
- **app:** the app no longer stops at "Caprock could not start: another
  Caprock daemon is already running" when its background service is still
  starting, which happened at login on a busy Mac. It waits for that daemon
  and connects to it. If the service does not answer, the app restarts it.
  Try again does the same.
