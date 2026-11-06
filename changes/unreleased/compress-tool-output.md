---
kind: Added
---
- **storage:** *Compress tool output*, under Status → Storage, stores tool
  calls and their results older than a day zstd-compressed, a few hundred
  rows at a time while Caprock is idle — never at start and never while
  anything is being recorded. Prompts and replies stay as they are, so search
  is unchanged. Off until you turn it on; the panel says how much smaller
  your own database would be (an estimate from 2,000 of your tool calls), and
  once it runs, how much it is. On a copy of a 2.5 GB database it saved
  818 MiB of tool output, and the file went to 1.5 GB after the one VACUUM
  that follows, which runs only when the disk has room for it. Turned off, the
  same job restores the rows. An older Caprock refuses to open the database
  after this upgrade (with a one-line message, changing nothing). Proposed
  and measured by [@SergeAx](https://github.com/SergeAx) in #672.
