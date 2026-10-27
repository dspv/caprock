---
kind: Fixed
---
- **app:** a daemon that answers slowly on a loaded computer no longer flips
  the window to "The Caprock daemon stopped". A check that times out keeps the
  daemon for 20 seconds; only a refused connection, or silence past that, shows
  it as stopped.
