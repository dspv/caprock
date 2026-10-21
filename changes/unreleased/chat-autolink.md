---
kind: Fixed
---
- **ui:** links in a chat can be tapped, on the phone too. A bare
  `https://…` address in an agent's reply was plain text; now every http(s)
  address in a reply, a prompt, the Answers tab and the last-word popover is
  a link that opens in a new tab (in the desktop app, your browser), with a
  sentence's trailing punctuation left out and a long address wrapping
  instead of widening the screen. Other schemes stay text.
