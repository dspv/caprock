---
kind: Changed
---
- **daemon:** a private module's document list asked for again without a
  tag is answered from memory while the collection is unchanged. Listing a
  21 MB collection of twelve pages took 62 ms and twelve database reads; it
  now takes 11 ms and none (four tagless listings and one write a minute:
  720 reads → 180). Who asks is logged at debug level.
