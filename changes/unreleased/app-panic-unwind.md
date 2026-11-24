---
kind: Fixed
---
- **app:** the Mac app no longer quits about once a week with "panic in a
  function that cannot unwind". An assertion inside macOS's own window code
  (seen while a display was being reconfigured) raised an exception that
  macOS would have logged and survived, but it unwound into the app's event
  handler and aborted it. That handler now catches such an exception, writes
  it to `app.log` with the stack it was raised on, and the app carries on.
  Release builds now unwind, so a panic in a menu, tray, window or
  notification callback is logged and the app goes on. Every panic in
  `app.log` now has its thread and a backtrace, and an abort that is still
  fatal names the last Objective-C exception raised.
