---
kind: Added
---
- **brain:** Second Brain no longer reads every session. A session a
  scheduled job starts can say so (`POST /v1/agents {"automation": true}`)
  and is never read or handed memories; Settings → Second Brain → *Never
  read these folders* skips every session in a folder (recorded as skipped,
  with the folder) and keeps those projects out of the graph, search and
  what a new session is handed unless you open that project. Nothing
  already kept is deleted. The instructions also tell the model to skip
  what is true only of one run (what the agent did or saved this time, a
  dropped connection) and keep what still holds for the product or the
  codebase.
