---
kind: Changed
---
- **cockpit:** Spend's period chip is split into whose and when: *session |
  all* and *since start · today · 7d · 30d* (*since start*, from the session's start,
  for this session only). This session over today, 7 or 30 days is its own
  calls in that window, by the hour or by the day, so three tabs on 30 days
  no longer draw the same chart; a window with no calls says so instead of
  showing zeros. Each tab keeps both picks, and the label always says both
  (*Today · this session*, *30 days · all sessions*).
- **cockpit:** Spend's Numbers row draws a figure from 1,000 up with a
  multiplier and two decimals (*$7.92k*, *$1.25M*, *13.71B*) instead of
  cutting it off; the exact value is on hover and for a screen reader.
