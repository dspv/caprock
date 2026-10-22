---
kind: Fixed
---
- **now:** the "sessions were still running when Caprock last stopped" banner
  no longer offers Continue on `claude -p` and Agent SDK runs. Those answer one
  prompt and exit, so a stop that caught one cut nothing off; Caprock now reads
  how the session was started from its transcript and leaves them out,
  including from a banner already showing.
- **loop:** a browser or computer-use tool taking the same screenshot,
  scrolling, waiting, pressing a key or navigating again is no longer flagged
  as a loop. That is how those tools work. A repeated click, typed text, edit
  or command still raises the alert.
