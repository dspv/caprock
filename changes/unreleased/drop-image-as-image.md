---
kind: Fixed
---
- **terminal:** two screenshots dropped into a Claude Code session no longer
  arrive glued together as `"/…/a.png""/…/b.png"` when Claude Code keeps them
  as text (it refuses to read a pasted image when its one-second check runs
  out, as on a heavily loaded Mac). Each image paste now starts with a space,
  which Claude Code trims when it attaches the image, so `[Image #N]` looks
  as before.
