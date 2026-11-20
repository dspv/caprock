---
kind: Fixed
---
- **store:** the daemon no longer reads the whole event history again every
  time a wide summary is asked for. The 7-day, 30-day and all-time figures
  behind the Cost screen, the cockpit's period, the projects panel and the
  lifetime strip are now kept per session, and only the sessions whose events
  moved are read again; the stored-event count in the status strip and a
  session's priced calls (the cockpit's spend scrubber) are kept the same way.
  Every figure stays the same. On a synthetic 1.6 GB, 680,000-event database
  with the dashboard and two session tabs open and two agents writing, the
  daemon's disk reads fell six- to sevenfold: from 24,361 MB to 3,489 MB an
  hour with the whole database evicted from memory every five minutes, and
  from 36,037 MB to 6,334 MB with it evicted every 30 seconds (2026-11-21).
  The stand evicts far harder than a real Mac, so the ratio is what carries
  over; the doctor's *Disk reads* row had been warning at 1.6 GB an hour.
