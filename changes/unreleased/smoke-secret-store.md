---
kind: Fixed
---
- **smoke:** the end-to-end smoke tests start their daemons with the file
  secret store, so running them on a Mac never writes a test token into the
  real login keychain; the Telegram smoke had replaced a developer's real bot
  token there.
