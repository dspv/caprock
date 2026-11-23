---
kind: Fixed
---
- **app:** right after a release the version panel no longer says "v0.190.0 is out" over a button that installs v0.189.1. The release check sees a new version a few minutes before the app's own update file is published; until it is, the panel says "v0.190.0 is being prepared — the app update is usually ready within 5 minutes of the release", offers no older install, looks again when it opens and every 2 minutes (at most 8 times), and then offers "Update to v0.190.0" in one jump. The app never installs an older update in a newer version's name, and Update automatically waits the same way.
