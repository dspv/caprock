---
kind: Fixed
---
- **app:** a Page tab opened on an address nobody answers no longer flashes
  a white rectangle before *Nothing answers at …*: a new page stays hidden
  until it has something to show.
- **app:** shrinking the window with a phone preview open no longer draws
  the page past the window's bottom edge while the tab catches up.
- **app:** a phone page drawn smaller than its true size reads the device's
  size exactly: an iPhone 16 reads 393×681, where it had read 392 wide side
  by side and up to three pixels short in height when scaled.
