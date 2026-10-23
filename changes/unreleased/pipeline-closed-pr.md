---
kind: Fixed
---
- **pipeline:** a pull request closed without a merge is no longer drawn in
  flight as *PR open*: a session's record of it made the row even though
  GitHub listed it closed. A row whose only title is its number now reads
  *#796*, not *#796 #796*.
- **pipeline:** one cost per pull request. The in-flight row, the list's
  *Agent cost* and the *Agents · 14 days* figure now read the same recorded
  spend (the in-flight row used to add up the whole sessions on it), and a
  pull request closed without a merge in the window counts toward the 14
  days: what agents spent on it was spent.
- **pipeline:** with no pull request merged in 14 days, *Speed* says *–*
  and why instead of *0.0/day*; with no agent cost recorded on any pull
  request, *Agents* says *–* and why instead of $0.00.
