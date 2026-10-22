---
kind: Added
---
- **mcp:** one-click Connect for `caprock mcp`. Second Brain opens with *Let
  your agents ask Second Brain* and a button per installed agent; a click runs
  `claude mcp add -s user caprock -- <path> mcp` or `codex mcp add …` on this
  machine, *Update path* fixes a registration that points at an old caprock,
  and *Disconnect* removes it. Settings shows the same status above the copy
  commands. Only on a click, never from a paired phone, and nothing leaves the
  computer (`GET /v1/mcp/agents`, `POST /v1/mcp/agents/{agent}/connect|disconnect`).
