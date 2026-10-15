---
kind: Added
---
- **pipeline:** what an hour of agent work costs, and how big the agent
  team is. Two new figures end the Flow row for the picked repository.
  **Cost / agent-hour** is the last 24 hours' spend per active agent-hour,
  at API list price (an estimate). An agent-hour is the burn rate's own
  rule: one session's clock hour with five or more priced calls. The
  figure carries a 15-day line, *▲ 35% vs 14-day avg*, and tokens per hour
  and in all. **Agent team** shows the main sessions and subagents at work
  in the last ten minutes and today's peak. Its line counts distinct agents
  a day, captioned with the 14-day average and peak, with each day split
  by agent kind on hover. Pressed, it opens a 31-day stacked bar chart,
  like a contributors graph. Both are read from this machine's events by
  the new `GET /v1/pipeline/agents`. With too little history they say
  *not enough history*.
