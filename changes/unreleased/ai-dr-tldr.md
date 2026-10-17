---
kind: Added
---
- **api:** AI;DR: `POST /v1/events/{id}/tldr` squeezes one agent answer into
  at most two short sentences, in the answer's own language, by a separate
  call to your own `claude` (Second Brain's headless runner, Haiku, no
  session written), only when you tap it. Never typed into the session. The
  result is kept, so a second tap makes no call; an answer under 280
  characters is its own TL;DR. A paired controller phone may use it
  (ADR-072).
