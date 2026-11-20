---
kind: Fixed
---
- **settings:** on Windows and Linux the search field's key, Ctrl+Shift+F,
  was drawn over the words *Search settings* in the menu. The key is now
  drawn only where the field has room for both; where it has none, the
  field's tooltip names it.
- **settings:** long section names in the Settings menu (*Live activity is a
  few seconds late*, *Talk to your agents from Telegram*) were cut at the
  menu's edge in the middle of a letter. They now end in an ellipsis, with
  the whole name on hover.
- **settings:** in the app, the last rows of the Settings menu were hidden
  under the status bar at the bottom of the window; the menu now ends above
  it.
- **settings:** in a narrow window, where the bar at the top of the page
  wraps to two or three rows, a section opened from the menu or from the
  sidebar's *phone, Telegram* landed with its heading behind that bar. It
  now lands below it, and the menu marks the section you clicked, not the
  one above it.
- **settings:** the list of missing Claude Code hooks no longer breaks a
  name in the middle (*PostToo* / *lUse*); it wraps between names.
