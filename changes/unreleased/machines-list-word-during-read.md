---
kind: Fixed
---
- **machines:** a prompt said on another computer while its sessions were
  being read could miss the one list for up to 10 s: the read from just before
  it was kept as fresh. Such a read is now answered but not kept.
