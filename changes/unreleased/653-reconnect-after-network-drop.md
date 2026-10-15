---
kind: Fixed
---
- **app:** terminals reconnect on their own after the network drops. A
  terminal whose connection was lost retried on a single timer, and the
  only thing watching it stopped with the socket: when the browser refused
  to start a new socket once (as a network stack being swapped under it
  can), or the timer was lost, the tab said *Reconnecting…* for good and
  nothing typed reached the session until the tab was closed (user report:
  every tab stuck after a Wi-Fi drop). A terminal between sockets is now
  checked every second and always has a retry on its way and on time; a
  pause for its own backlog resumes after 15 s even if the terminal never
  reports catching up; and the window getting focus checks the connection
  at once. The badge says the attempt and the next try, and after 3
  failed tries or 10 s down offers **Reconnect now**, which reconnects the
  same session — no new process. The dashboard's live connection got the
  same watchdog and button.
