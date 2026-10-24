---
kind: Fixed
---
- **agents:** a session whose program exits a moment after it starts now
  says why. Its tab shows *Claude Code exited at once (code 1)* with the last
  lines it printed, the program that ran, and **Try again** and **Close**,
  instead of *Connecting to the session… Can't connect · next try in 5 s*
  over a process that was already gone. The same lines, the command and the
  binary's version go to service.log at WARN, and `GET /v1/agents/{id}/exit`
  serves them (kept in the new `session_exits` table).
- **agents:** *Continue here* on a Claude Code session that moved to another
  folder with `cd` starts in the folder its conversation began in. Started in
  the moved-to folder, `claude --resume` printed "No conversation found" and
  exited at once.
