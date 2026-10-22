---
kind: Fixed
---
- **app:** a terminal tab left out of sight for ten minutes keeps the last
  1,000 lines of its scrollback instead of 10,000, and has the full 10,000
  again when shown. Every tab ever opened used to hold its whole scrollback:
  ten full tabs held 103 MB of the window's memory, 24 MB once trimmed
  (measured 2026-10-22). The tab in front and anything shown in the last ten
  minutes are unchanged, and nothing is redrawn on the way back.
- **daemon:** cached dashboard answers for a past day or range are dropped
  once they are too old to show (they were kept for as long as the daemon
  ran); a session Caprock started that crashes or is killed no longer leaves
  its last tool inputs in memory; and the daemon sets a soft 256 MiB ceiling
  on Go's own memory (unless `GOMEMLIMIT` is set). A heavy synthetic load
  stayed under 90 MB of it (measured 2026-10-22); near it the daemon collects
  harder and returns memory to the system instead of growing.
