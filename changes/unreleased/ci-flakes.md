---
kind: Fixed
---
- **remote:** revoking a device closes its terminal opened through the relay
  at once, with "this device was removed". A keystroke arriving as the socket
  closed used to drop the stream without telling the other computer, and its
  terminal stayed open.
- **daemon:** stopping the daemon waits for its background work (history
  backfills, pruning, Second Brain's loop, the projects list and any clone
  still running) before the database closes, instead of leaving it to read a
  closed database; a clone in progress is stopped rather than left writing.
- **ci:** `make pr-check`, the step before a pull request: the changed Go
  packages with `-race`, their changed tests three times, a Windows vet and
  test build, and the changed dashboard tests. Four flaky tests were fixed at
  the root.
