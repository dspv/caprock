---
kind: Fixed
---
- **machines:** a computer that is on and answering no longer shows as
  *offline* with a red dot in the sidebar while its page says online. The
  sidebar, the computer's page and All computers now take online or offline
  from one place, the channel to that computer; a read that was slow or
  failed no longer counts as offline, and the daemon calls a read that runs
  out of time on a live channel *slow to answer*, not offline.
- **machines:** a computer's page never sits on grey placeholder rows for
  good. It shows what runs there from the sidebar's list at once (*Nothing
  runs on <name> now.* when nothing does), and every read of another
  computer ends: the daemon gives up on a read through the proxy after 30 s
  and the dashboard after 35 s, with *Try again*.
