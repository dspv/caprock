---
kind: Fixed
---
- **app:** a window that goes white comes back by itself instead of staying
  blank until the app is quit. When macOS ends the WebView's content process
  (under memory pressure, or a crash), the app reloads that window, waiting
  longer each time it repeats. A page the app asked for that never finished
  loading is loaded again while the daemon answers. A page that loaded but
  drew nothing (a file of it missing while the daemon restarted) shows
  *Reconnecting to Caprock…* with Reload and reloads once the daemon
  answers. Each of these, and the crash screen, writes one line to the app's
  own log on your Mac (`app.log` in Caprock's data folder), so a report can
  say why; nothing is sent anywhere.
