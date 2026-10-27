---
kind: Fixed
---
- **ui:** the window holds much less memory over a long day. The Live pulse
  kept every tool's whole answer (command output, files read in full, an
  edit's original file) for up to 4,000 events a track; it now keeps what the
  bars read. An open chat following a busy agent no longer grows for as long
  as it stays open: past 240 messages it keeps the newest 120 and pages the
  rest back in when scrolled to. A session's timeline left open keeps 1,000
  live events instead of 5,000. The agent cockpit keeps a result's outcome,
  not its output, and clipped text no longer keeps the full original alive.
