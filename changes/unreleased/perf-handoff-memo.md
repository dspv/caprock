---
kind: Changed
---
- **daemon:** the memory status no longer reads every handed session's
  events once a minute. A session's first edit is kept once found, and one
  with none yet is read again only after its events moved. On the stand a
  refresh was 322 statements and 5.8 MB of reads; later refreshes now read
  only the sessions that moved. On the owner's Mac this was about 1 GB of
  disk reads an hour.
