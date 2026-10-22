---
kind: Added
---
- **modules:** a private module can say what waits on you in it, with `PUT
  /v1/x/<id>/attention` (a count and up to eight items, each a short label and a
  `#route` inside the module). Its sidebar row shows a small *2 waiting*; a
  click unfolds the items, and an item opens the module right there. The row and
  Second Brain above it fold as an accordion. At 0 the row is unchanged, and a
  report stops showing a day after the module last sent one.
