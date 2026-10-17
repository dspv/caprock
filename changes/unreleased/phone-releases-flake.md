---
kind: Fixed
---
- **release:** 0.128.0 was tagged but never published: a phone Releases test
  read the "read N ago" line before the stats answer had drawn it, and failed
  the release run. The test now waits for the line; 0.128.1 carries 0.128.0.
