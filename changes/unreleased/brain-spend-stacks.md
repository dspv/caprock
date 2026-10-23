---
kind: Changed
---
- **brain:** Second Brain's *Last 14 days* shows where the tokens went. Each
  day's bar is stacked by project: the three that spent the most each get a
  colour, everything else is one grey *Other*, and hovering a segment names
  the project, the day and its tokens. A day over the limit keeps its
  colours and gets a warn dot above it. The table puts the same colour
  before each project's name and a thin bar after its tokens, sized against
  the project that spent the most. `GET /v1/brain/spend` now splits each
  day by project (`days[].projects`).
