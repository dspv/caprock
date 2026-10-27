---
kind: Added
---
- **ios:** Caprock for iPhone, version 1.0, ready for the App Store, in
  `ios-app/`: the phone remote in a Capacitor shell, bundled rather than
  loaded from `m.caprock.dev`. Pair by scanning the computer's code with the
  app's own camera, or paste the link; dictate in any language the iPhone
  recognises on its own, with nothing sent anywhere and a line when a language
  is not on the device; lock the app behind Face ID; the pairing kept in the
  Keychain; **Try it without a Mac** on bundled sample data that connects to
  nothing; the app's own Settings (paired computer, voice language, Face ID,
  unpair). Nothing in the app is for sale. A manual workflow
  (`ios-release.yml`) archives, signs and uploads a build to App Store
  Connect; the listing texts are in `ios-app/store/`. No push notifications
  in 1.0; they follow in 1.1 (ADR-083).
