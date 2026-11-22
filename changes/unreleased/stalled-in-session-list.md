---
kind: Added
---
- **sidebar:** a Claude Code session whose last message got no reply is
  marked in the session lists, so a silently stuck agent is seen without
  opening its chat. After 15 minutes with no event in an open turn, and no
  call running, its row (Open, under its project, *Running, no tab*, and the
  phone's Continue) has
  an amber dot and says *no reply 2d* — *25m*, *2h*, *12h*, *2d* — with
  *Your last message got no reply. Open it to send again.* in its tooltip.
  Such a row no longer folds into Background. The sessions list carries a new
  `turn_open` field, read from the events it already reads.
