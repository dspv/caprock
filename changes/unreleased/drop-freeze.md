---
kind: Fixed
---
- **app:** dropping a file on the window no longer touches the disk on the
  thread that draws the app. A file from Finder is handed to the terminal as
  it is; a screenshot thumbnail or another temporary file is copied on a
  background thread first. On a Mac short of memory and swapping, that copy
  could freeze the window for seconds.
