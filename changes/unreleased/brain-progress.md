---
kind: Added
---
- **brain:** see Second Brain build. A header strip on its screen says the
  state (*Building · reading session 12 of 48* over a progress bar, *Up to
  date · last built 14:02*, *Paused*, *Stopped*, *Waiting* for today's
  limit), which step a read is at (find sessions, Claude extracts, link into
  the graph) with the session being read, what it gives (how many new
  sessions were handed its memories) and counted figures: memories, new
  today, topics, links, tokens and cost at API list price in the last 24
  hours. The folded sidebar card reads *Building · 12 of 48* over a thin
  bar while it builds. `GET /v1/brain/status` carries `stage`, the read's
  `phase` and these counts; migration 0058 records the memories each new
  session is handed.
