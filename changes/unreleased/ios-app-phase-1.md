---
kind: Added
---
- **ios:** the iOS app's first phase, in `ios-app/`: the phone remote in a
  Capacitor shell, bundled rather than loaded from `m.caprock.dev`. Pair by
  scanning the computer's code with the app's own camera, or paste the link;
  dictate in any language the iPhone recognises on its own, with nothing sent
  anywhere and a line when a language is not on the device; lock the app
  behind Face ID; the pairing kept in the Keychain; **Try it without a Mac**
  on bundled sample data that connects to nothing; the app's own Settings
  (paired computer, voice language, Face ID, unpair). Nothing in the app is
  for sale. Built for the iOS Simulator on GitHub's macOS runners; not yet
  signed or on TestFlight, and no push notifications yet (ADR-083).
