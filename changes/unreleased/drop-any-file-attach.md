---
kind: Changed
---
- **app:** a file dropped on an open chat in the desktop app now attaches
  exactly as the Attach button's pick does, whatever its type: the app reads
  its bytes (only a file from that very drop, at most 10 MB), Caprock saves a
  copy and the chip shows its short name — not the file's full path, which is
  how a dropped PDF, Markdown or source file used to go. Over 10 MB it gets
  Attach's line. A folder is still turned away as before; an app built before
  this keeps attaching a dropped document by its path.
