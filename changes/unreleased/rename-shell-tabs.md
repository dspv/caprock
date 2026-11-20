---
kind: Fixed
---
- **app:** a shell tab can be renamed again. When you start an agent in a
  shell yourself — `claude --resume <id>` typed into the shell a dead
  session's tab became — the tab and its sidebar row take that session's
  name instead of *Shell 1 · claude*, say *in Shell 1* on hover, and Rename
  renames the session, from the tab, the row or the row's menu. When the
  agent exits the tab is *Shell 1* again. A plain shell's tab is renamed
  too: its name is kept with your tabs, and an empty one gives back *Shell N*.
