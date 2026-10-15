---
kind: Fixed
---
- **app:** only the tab you are in looks selected (a user could not tell
  where she was: the tabs waiting on her wore the same accent bar along
  their top as the tab in front, so four tabs looked selected). The tab in
  front alone has the 3px accent edge, the panel's fill and a bold title,
  and room for about 16 characters of it — it read *ca…*; there its
  project's name gives way first. A tab waiting on you shows an amber dot
  before its title, pulsing slowly; one looping or failed a red dot. Never
  a bar.
- **app:** closing an agent's tab is one decision at most, and always says
  the conversation is saved. An idle agent Caprock started ends with its
  tab, no question, and a toast says *Closed. The conversation is saved —
  reopen it from History or the sidebar.* One still working or waiting gets
  one sentence, **Close tab** (it keeps working in the background) and a
  quiet *Stop it instead*; no checkbox. Settings → Closing a tab still
  makes it always keep or always stop. Ending now asks the agent to stop
  (SIGTERM, then a kill after 5 seconds) instead of killing it at once, so
  Claude Code writes its transcript out and the session can be continued
  with --resume; the agent-signal endpoint takes `end` for this.
