---
kind: Changed
---
- **brain:** memories moving: when a read keeps memories, one silver thread
  for the whole read drifts from that session's row (else its tab, its
  project's row or its agent's face) into the sidebar's Second Brain, which
  ripples and shows *+N*; when a new session is handed memories, a thread
  goes the other way into its tab with *N memories handed*. At most one a
  minute each way, with counts merged, never while you type, nothing in a
  hidden window; with reduced motion only the count shows. The setting is
  now *Show memories moving* (same switch, one for both directions). The
  card's agent faces now show only agents whose sessions were read in the
  last 24 hours, each with how many, and the one being read glows; the orb's background sparks
  no longer look like memories arriving. The live `brain` frames gain a
  read's start and end (`phase`, `run`, `agent`, `added`) and a `handoff`
  frame, and `GET /v1/brain/status` gains `auto.agents_24h`.
