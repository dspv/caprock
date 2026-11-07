---
kind: Added
---
- **storage:** The status strip at the bottom of the window shows how far
  compression has got (*Compressing · 40% · 224.6MB saved*), and once it has
  caught up and packing the file would free a meaningful amount, offers *Pack
  database · ~85 s*. A click opens the details: how long it takes and what it
  frees, both estimated from this database, that sessions keep running and new
  events wait, and **Pack now**. Every event that arrives during the pack is
  recorded when it ends. The pack shows a progress bar measured from what
  SQLite has written. `GET /v1/storage/pack` reports the job and the pack,
  `POST` starts one, and `GET /v1/storage`'s `compression` gains the job's
  progress.
