---
kind: Fixed
---
- **brain:** a session opened in `/` (a background `claude` run there is
  labelled `/`) no longer stalls Second Brain. Its project could not be
  stored, so every read of it failed whole, was never recorded, and the same
  chunk was asked again every few seconds: 3,363 times in 13 hours on one
  machine, its tokens counted toward neither the retry wait nor the daily
  limit. Such a session is now read in no project; an answer that cannot be
  stored is recorded as a failed read with its tokens and waits out the retry;
  and one memory that cannot be stored is left out while the rest of the read
  is kept, a memory sent with no title taking one from its summary.
- **brain:** the Second Brain strip says a read that did not finish in plain
  words — *The last read didn't finish (Claude's answer could not be saved).
  Caprock tries that session again by itself in 15–60 min and goes on with
  the others.* — with the raw error only in its tooltip, and so do Settings'
  *Last problem* line and the *Just read* list (*given up after 4 tries*
  instead of *too short* for a session given up on).
