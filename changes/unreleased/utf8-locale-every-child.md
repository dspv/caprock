---
kind: Fixed
---
- **agents:** text copied from an agent (its `pbcopy`) keeps non-Latin letters: every process Caprock starts gets a UTF-8 locale when it has none, not only agent tabs, and the daemon sets one on itself at start.
