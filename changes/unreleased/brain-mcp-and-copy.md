---
kind: Fixed
---
- **mcp:** `memory_topics` with a project now counts that project's memories
  and lists that project alone, instead of the totals for every project
  beside one project's topics. `session_summary` says how many files a long
  session touched beyond the 40 it lists (*+N more*), counted from the whole
  session rather than the daemon's first 100.
- **brain:** the screens no longer promise every agent what only Claude Code
  gets. Any agent's sessions add memories, but only a Claude Code session is
  handed them at start; the tagline, the agents line (*Claude Code and Codex
  add to it; Claude Code sessions start with it.*) and the third step of
  *How it works* now say so. *Links* on the Brain screen counts links from
  one memory to another only, not each memory's link to its topic or
  project.
