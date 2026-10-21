---
kind: Changed
---
- **ui:** The phone home is shorter and says more at a glance. *New chat* is a
  filled button in the Chats row. Continue, Releases and Saved fold from their
  headers (Continue open, the other two folded at first), and a folded section
  keeps one line: how many sessions wait, work and sit idle; the repository and
  its next release, with a pull request whose CI failed said first in red; how
  many notes were saved and the newest. The phone remembers the folds. A new
  *Limits* line shows the 5-hour window with its reset and the weekly one,
  amber from 80% and red from 95% (Codex's when Claude Code has none), and
  opens Cost at its plan limits. A live Continue row says its context used and
  its subagents at work.
- **api:** `GET /v1/stats/limits` answers the plan windows alone
  (`rate_limits`, `codex_rate_limits`), as the summary carries them, so the
  phone reads two percentages without the whole summary. A paired device may
  read it.
