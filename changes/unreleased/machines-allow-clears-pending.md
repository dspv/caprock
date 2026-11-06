---
kind: Fixed
---
- **machines:** after the other computer's owner pressed Allow, the sidebar,
  Now and New agent kept saying "waiting for Allow" until Settings → Computers
  was opened, and the next look came a minute later. A computer that lets this
  one in — a socket opens, a request is answered — is now asked again by
  itself, one that waits for Allow is looked at again after 5 s, 10 s, 20 s…,
  and the same clears "removed" when that computer knows this one again. In
  the two-daemon smoke the laptop learned of the Allow about 3 s after it.
