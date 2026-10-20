---
kind: Changed
---
- **app:** the macOS app is now signed with Caprock's Apple Developer ID and
  notarized by Apple, the `.app` and the `.dmg` stapled, so it opens without
  "Open Anyway" and the Homebrew cask no longer clears the quarantine flag.
  macOS keys privacy answers to the app's signature, and this signer is new
  to it: on the first launch of the first release signed this way Caprock
  asks once more for the microphone and for each folder it was allowed, and
  updates keep the answers from then on. Answers given to `claude` or
  `codex`, notifications and keychain passwords are not affected. While the Apple secrets are missing a release
  falls back to the self-signed certificate, as before.
