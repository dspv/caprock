---
kind: Fixed
---
- **machines:** after another computer's Caprock restarted, this one kept
  asking it for frames past its new count, got a reset on every reconnect, and
  lost the prompts said there while the link was down; it now resumes from
  where that computer stands. A computer that lets the watch in and hangs up at
  once is waited out (2 s doubling to 60 s) instead of re-dialled every 2 s.
