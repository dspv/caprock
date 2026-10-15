---
kind: Changed
---
- **app:** "Caprock on this computer" (the popover behind *caprock 1.6 GB ·
  1.8 GB* in the status bar) says what is wrong in one line — *All good —
  Caprock uses 1.6 GB*, or *Caprock is using more than it should* with one
  **Clean up (frees ~X MB)**. Below it, one row per kind of problem in plain
  words, each with a line of why, its size and a small Stop: *Test copies of
  Caprock* (left by agent work in temporary folders and worktrees, not your
  app), *Leftover helpers* (servers finished agent sessions left running),
  *Disk reads* (normal or more than usual). Pids, paths and the long
  explanations moved under each row's *Details*; the memory and disk
  breakdown is behind *What the 1.6 GB is spent on*. Every stop shows the
  list first, one checkbox per process with the safe ones ticked, and stops
  nothing until you click *Stop*. The *Advanced* checkbox is gone.
