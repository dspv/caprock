---
kind: Fixed
---
- **machines:** a session on another computer opens in the same tab as a
  local one: the live terminal first, the Chat/Terminal switch in the strip
  and the agent cockpit beside it, read from that computer, instead of the
  dashboard's Session view with a phone's row of touch keys. The app's keys
  (⌘1–⌘9, ⌘W, ⌘I…) work while its terminal has the keyboard, the tab names
  the folder it runs in beside the computer's tag, and closing it puts it on
  Recently closed. New agent on another computer no longer cuts its folder
  picker at the sheet's edge on a long path.
- **ui:** the touch keys (Esc, Tab, arrows, Enter, Ctrl+C) are never drawn
  under a mouse: only on a phone or a touch screen.
- **agents:** a Claude Code session Caprock starts no longer waits on Claude
  Code's "Adding a new directory" prompt for Caprock's own paste and chats
  folders: every folder passed with `--add-dir` is trusted beforehand as the
  working folder is, so sessions started on a computer nobody sits at no
  longer exit at once (#1118).
- **sessions:** a Claude Code session Caprock started that has sent no hook
  20 seconds after the start, with the hooks installed, reads *waiting at a
  prompt in its terminal* — Needs you, in amber, in the sidebar, its
  computer's count, the tab, the tray and the phone — instead of running,
  and its tab opens on the terminal where the prompt is.
