---
kind: Added
---
- **machines:** start an agent on another computer from this one. New agent
  gains a Machine field when you have linked a computer: pick it, and the
  folders, agents and models are read from that computer, the agent runs
  there, and its tab opens here. A computer that cannot take a start is
  listed with why (offline, waiting for Allow, removed there), and a refusal
  is said in words, a folder missing there included.
- **machines:** one list across your computers. Sessions on the other
  computers that need you sort first in the sidebar, Now shows them under
  *On other computers*, and the app tells you when one needs you, naming the
  computer. A computer that goes away is shown as offline with when it last
  answered, not with the sessions it had. The daemon reads each computer once
  for every window (`GET /v1/machines/sessions`) and listens to it for
  prompts only while a window is open.
- **machines:** a guide for trying it on two computers,
  `docs/machines.md`, and an end-to-end test with two real
  daemons and a local relay in the smoke suite.
