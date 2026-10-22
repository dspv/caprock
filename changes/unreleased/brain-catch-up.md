---
kind: Added
---
- **brain:** Second Brain now goes back and reads what it skipped. Before
  this release, a read of a long session kept only its newest part, and the
  older part was never read. Caprock now finds those skipped parts on its
  own and reads them oldest first. It does this only while automatic
  reading is on, only when no new session is waiting, and within the same
  daily token limit. The Second Brain status shows how far it has got and
  estimates how many days the rest will take.
