---
kind: Added
---
- **ui:** the Lifetime screen says, under its daily chart, that Claude Code
  deletes conversations older than its `cleanupPeriodDays` (30 days unless
  set), so the history before Caprock's first day was gone before Caprock saw
  it, and offers **Keep them from now on**: it writes `cleanupPeriodDays:
  36500` into `~/.claude/settings.json`, that key only and every other byte of
  the file kept, backed up first, and refuses a file that is not valid JSON.
  Shown only while the period is unset or 90 days or fewer; nothing leaves
  the machine (`GET`/`POST /v1/claude/retention`).
