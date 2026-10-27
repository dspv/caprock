---
kind: Fixed
---
- **app:** a daemon that answers slowly on a loaded computer no longer flips
  the window to "The Caprock daemon stopped". A daemon that takes the connection
  and answers late is kept for 20 seconds; no connection at all, or silence
  past that, shows it as stopped.
