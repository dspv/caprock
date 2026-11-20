---
kind: Fixed
---
- **cockpit:** the CI and Release sections read cleanly in the narrow
  right panel. Asking to fix a pull request's CI fits on one line (*Ask to
  fix #977 CI? Confirm Cancel*, the whole sentence on hover), and so do
  Re-run, Update branch and Resolve conflict. One link under the CI list
  instead of two: *#977 log in Pipeline →* while a pull request fails,
  else *Pipeline →*. The Release section says *Next 0.185.3 · patch · 36m
  ago* rather than cutting it, names the pull request it waits for once,
  with its state (*Waiting for #977 · CI red*, the failed check on hover),
  says a failed check in plain words (*e2e failed*), and gives each entry
  two lines.
- **cockpit:** CI no longer shows an old red at full strength when the
  window opens. A status kept from before is drawn faint, *as of 25 min
  ago*, while GitHub is read again, and the read goes out at once when the
  window, a tab or the app comes into view or the window is brought to the
  front, not at the next minute's poll.
