---
kind: Changed
---
- **app:** the macOS app is now signed with Caprock's Apple Developer ID and
  notarized by Apple, the `.app` and the `.dmg` stapled, so it opens without
  "Open Anyway" and the Homebrew cask no longer clears the quarantine flag.
  The new signer is new to macOS: on the first release signed this way every
  user answers the microphone and folder prompts once more, and updates keep
  the answers from then on. While the Apple secrets are missing a release
  falls back to the self-signed certificate, as before.
