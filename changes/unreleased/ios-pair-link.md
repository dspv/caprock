---
kind: Fixed
---
- **ios:** pairing the iPhone app by its scanner works. The code was read,
  but the app's web view ignored the address change that carries the link,
  so the page reloaded back to the welcome screen and nothing happened. The
  same fix covers pasting a link and adding a second computer in the app.
