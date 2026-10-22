---
kind: Fixed
---
- **terminal:** a terminal tab whose session's process is gone no longer
  spins on "Reconnecting…" for good. After the background service restarted,
  tabs for sessions that died with it were refused by the daemon on every try,
  and a browser is never told why. Now, after three refused tries, the tab
  asks the daemon and says what is wrong and what to do ("Can't connect" with
  the reason); a session the daemon still does not hold about 20 s later is
  ended, and the app shows its conversation with Continue here. A tab restored
  for a running session whose terminal Caprock lost opens that way at once,
  and a session the daemon holds is served even when no new agent could be
  started.
