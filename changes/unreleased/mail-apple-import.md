---
kind: Fixed
---
- **mail:** *Import everything* no longer hides Apple Mail when macOS keeps
  Caprock out of its account list. iCloud, Google and Exchange accounts in
  Apple Mail were silently missing because the list sits behind Full Disk
  Access, which macOS never asks for. The screen now says *Caprock can't read
  Apple Mail's account list*, with *Open Full Disk Access* (opens that list in
  System Settings and shows Caprock's program in Finder) and *Add iCloud with
  an app password instead*. Adding iCloud now walks through getting an
  app-specific password in three short steps, with a button that opens
  account.apple.com and one field for the code. An iCloud account found in
  Apple Mail is marked *Needs an app password*.
