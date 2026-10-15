---
kind: Changed
---
- **ui:** a GitHub read that fails on the network or with a 5xx now says
  *Couldn't reach GitHub. Showing data from 6 min ago.* with *Retry*, the raw
  error and the exact time in the tooltip, and then what GitHub's status page
  reports: an outage with a link to it, or *all systems operational — likely
  your connection*. *Watch GitHub Status* in that line, off by default, shows
  a dot in the status bar while GitHub reports an incident. The daemon reads
  githubstatus.com only while GitHub is connected, with nothing about you.
