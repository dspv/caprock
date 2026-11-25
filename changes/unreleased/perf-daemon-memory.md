---
kind: Changed
---
- **perf:** a write to one of a private module's documents now sends only the
  page of its list that holds that document back to the database. Before,
  every write re-read every page of the collection: the Ops module's
  busiest collection, twelve pages long, took about 2,000 writes an hour,
  and its lists were still the daemon's largest disk reader (1.44 GB of
  5.2 GB in an hour on 0.196.0). Pages the write did not touch keep their
  ETag and are answered from memory.
- **perf:** the daemon holds less Go heap for the summaries: one copy of each
  kind, model, tool and folder name per read instead of one per session, and
  the stored summary parts are compressed with an encoder that is dropped
  afterwards, not with the shared one that kept an 8 MB buffer for good.
