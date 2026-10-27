---
kind: Added
---
- **cockpit:** **Compact context**, free. In the Context section, one click
  types Claude Code's own `/compact` into a session Caprock started — at once
  at its prompt, otherwise when its turn ends — and the session carries on
  in place with a summary; `/clear` is never typed. The collapsed Context
  line shows a small icon from 60% full; both are hidden under 100k tokens.
  Before the press it says what usually stays and where that comes from:
  your own compactions once five are measured, until then one machine's
  measurement (70 automatic compactions, 2026-09-29 to 2026-10-25, a median
  15% kept). After it, the measured before and after, *Compacted: 41.4k →
  10.1k tokens* — at once where Claude Code writes the size after on its
  compaction boundary, else with the next reply. A session another terminal holds is never typed into: it
  shows the command to type there and Continue here. Compaction boundaries
  are now read from transcripts, including the ones already on disk, once,
  in the background (`GET /v1/sessions/{id}/compaction`,
  `POST /v1/agents/{id}/compact`).
