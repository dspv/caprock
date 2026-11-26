---
kind: Fixed
---
- **ptyhost:** voice input (`/voice`) in a Caprock terminal on macOS no
  longer dies with "No audio detected from microphone" after a Caprock
  update. The update replaced the Caprock Terminal helper that open
  terminals ran from, so macOS could no longer check their signature and
  silently refused them the microphone. Terminals now run from a copy of the
  helper the daemon keeps per version, which an update leaves in place until
  the last terminal on it closes; same bundle id and signature, so your
  Allow still applies. A terminal opened before this update still needs one
  restart for voice.
