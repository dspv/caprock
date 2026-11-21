---
kind: Changed
---
- **resources:** A large history is no longer a warning. Keeping every
  session is what spend over all time, search across old sessions and Second
  Brain stand on, so Caprock resources now says the size as a plain line,
  *History · 2.1 GB*, with no amber dot and no *Set a retention period*
  button, and `caprock doctor` no longer prints a Verdict line for it. What
  does warn is a nearly full disk: under 5 GB free on the disk that holds
  Caprock's data (a threshold we chose, not a measured limit). *Disk is nearly
  full* says how much is free, names Caprock's history as its largest item
  there with its size, and opens Settings → Storage; it never tells you to
  delete the history. `caprock doctor` says the same, and its Disk heading
  now shows the free space on that disk.
