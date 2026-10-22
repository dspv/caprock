---
kind: Fixed
---
- **memory:** the memory popover no longer lists an app bigger than the
  group it sits in (colima at 8.2 GB under *Other apps and the system* at
  7.6 GB). The used figure is RAM, while an app's size counts its compressed
  and swapped-out memory too, as Activity Monitor does; an idle virtual
  machine's guest is mostly in swap. The group now takes what its apps hold
  when that is more, an app running a virtual machine is marked *· virtual
  machine*, the card says when the sizes add up past what is in use, and the
  stacked bar never runs past the used share.
