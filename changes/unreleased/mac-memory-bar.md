---
kind: Added
---
- **ui:** the status bar shows the machine's memory: *Mac 9.1/16 GB* with a
  small green bar, amber with what the agents hold when the system warns or
  85% is in use, and red *Memory low* when the pressure is critical or swap
  keeps growing. A click shows who holds it — agents, Caprock, other apps —
  each agent with its state, the apps using the most, and one button that
  ends the idle agents Caprock started (their conversations are kept;
  Continue picks them up). Agents started elsewhere are listed, never
  touched. Read from the OS's own figures on macOS, Linux and Windows, only
  while a window is open; a paired phone sees the totals, not other apps'
  names. An agent whose one process passes 3 GB (or a fifth of the
  machine), or grows for hours, is flagged in the popover and its
  inspector with **Restart it fresh**: the process ends and the same
  conversation continues in a new one. Memory is each process's physical
  footprint on macOS, compressed pages included, as Activity Monitor shows.
  New `GET /v1/system/memory`, `POST /v1/system/memory/end-idle` and
  `POST /v1/system/memory/restart`.
