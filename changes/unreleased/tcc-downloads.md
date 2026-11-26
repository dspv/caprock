---
kind: Fixed
---
- **app:** an image dragged from Downloads, Desktop, Documents or iCloud
  Drive into a terminal arrives as Claude Code's `[Image #N]` again instead
  of a bare path: on macOS the app copies it into Caprock's paste folder
  first, since macOS may refuse the session that folder without asking.
  Other files are still typed where they are.
- **app:** Caprock Terminal, the helper macOS asks about for programs in a
  Caprock terminal, now says why they may read your Desktop, Documents,
  Downloads and removable or network drives; 0.197.0 lacked these
  descriptions and sessions were refused Downloads with no prompt.
- **terminal:** when macOS refuses a session a protected folder
  ("Operation not permitted" on Downloads, Desktop, Documents, iCloud Drive
  or a drive), a line under the terminal names the folder and the exact
  entry to switch on in System Settings → Privacy & Security, and **Open
  Settings** opens Full Disk Access with that program shown in Finder.
  Nothing opens until you click.
