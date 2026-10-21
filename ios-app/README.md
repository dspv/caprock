# Caprock for iPhone

The phone remote as a native iOS app ([ADR-083](../.ai/08-decisions.md)): the
same React screens as `m.caprock.dev`, built from `ui/` with
`vite build --mode remote`, bundled into a [Capacitor](https://capacitorjs.com)
shell, plus what only an app can do. Free; nothing in it is for sale. What
each screen does is in [`.ai/04-ui.md` § The iOS app](../.ai/04-ui.md#the-ios-app).

**Never build this on the owner's Mac.** The Simulator build runs on GitHub's
macOS runners (`.github/workflows/ios.yml`) on every push to `master` or a
`feat/ios-*` branch, and every pull request, that touches this folder,
`ui/src/remote/`, `ui/src/native/` or the UI's package files.

## Layout

```
ios-app/
  package.json            # Capacitor CLI, iOS runtime and the plugins, pinned exactly
  capacitor.config.json   # appId dev.caprock.ios, webDir ../ui/dist-remote, keyboard, insets
  scripts/check-versions.mjs  # ui/ and ios-app/ pin the same plugin versions (CI runs it)
  ios/                    # the Xcode project, committed (Swift Package Manager, no CocoaPods)
    App/App/              # AppDelegate, Info.plist (permission strings), icon, launch screen
    App/CapApp-SPM/       # Package.swift that `cap sync` writes from the plugins
    App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved  # Swift packages, pinned
ui/src/native/            # the app's half of the UI, loaded only inside the app
```

The web assets are not committed: `cap sync` copies `ui/dist-remote` into
`ios/App/App/public/` (ignored). The JavaScript of each plugin is imported by
`ui/` and its native code is built from `ios-app/node_modules`, so both
`package.json` files pin the same version; `scripts/check-versions.mjs` fails
CI when they drift.

## Plugins

| Package                               | Version | For                                                                 |
| ------------------------------------- | ------- | ------------------------------------------------------------------- |
| `@capacitor/core`, `cli`, `ios`       | 8.5.3   | the shell                                                           |
| `@capacitor/barcode-scanner`          | 3.1.3   | pairing by the camera (official)                                    |
| `@capgo/capacitor-speech-recognition` | 8.4.4   | dictation with on-device recognition required                       |
| `@aparajita/capacitor-biometric-auth` | 10.0.0  | the Face ID lock, passcode fallback                                 |
| `@aparajita/capacitor-secure-storage` | 8.0.1   | the pairing and the lock setting in the Keychain (this device only) |
| `@capacitor/keyboard`                 | 8.0.6   | the WebView resized natively above the keyboard                     |
| `@capacitor/app`                      | 8.1.2   | app lifecycle, needed by the biometric and secure-storage plugins   |

The bundle id is `dev.caprock.ios`, beside the desktop app's `dev.caprock.app`
(`app/src-tauri/tauri.conf.json`), under CYBRIX LLC's developer account.
iPhone only, portrait, iOS 15 or later.

## Build (CI, or a Mac that is not the owner's)

```bash
npm --prefix ui ci && npm --prefix ios-app ci
node ios-app/scripts/check-versions.mjs
(cd ui && npx vite build --mode remote)      # ui/dist-remote
(cd ios-app && npx cap sync ios)              # copies it in, rewrites CapApp-SPM/Package.swift
xcodebuild -project ios-app/ios/App/App.xcodeproj -scheme App -configuration Debug \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO build
```

After changing a plugin, run `npx cap sync ios` and commit the rewritten
`CapApp-SPM/Package.swift`; CI fails when the committed one is stale. The
Swift packages the plugins pull in (`capacitor-swift-pm`, `keychain-swift`,
`OSBarcodeLib-iOS`) are pinned by the committed
`App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved`,
which CI builds with `-onlyUsePackageVersionsFromResolvedFile`; a plugin
update that needs other versions fails there, and the failed run prints what
it resolved.

## What is not built yet

- **Push notifications** ("Claude is waiting for your answer", "task done"):
  wait on `OQ-24` (what a push may carry) and the sender service.
- **Signing and TestFlight upload:** a release job that signs with the
  App Store Connect key below and uploads; it needs the owner's steps first.
- **Get the app** on `m.caprock.dev`, once the app is in the App Store.

## The owner's steps in App Store Connect (nothing here is done for you)

Account: CYBRIX LLC, the developer account that signs the Mac app. Every step
is a click of the Account Holder or an Admin; none can be done by an agent.

1. **Agreements.** App Store Connect → **Business** (Agreements, Tax, and
   Banking): accept any pending Apple Developer Program License Agreement.
   The app is free, so the Paid Apps agreement, tax and banking are not
   needed for it.
2. **The bundle id.** developer.apple.com → Certificates, Identifiers &
   Profiles → **Identifiers** → **+** → App IDs → App. Description
   *Caprock for iPhone*, explicit Bundle ID `dev.caprock.ios`. No
   capabilities for now (Push Notifications and an App Group come with
   phase 2).
3. **The app record.** App Store Connect → **Apps** → **+** → New App.
   Platform iOS; Name *Caprock* (if the name is taken, pick the shown name
   then); Primary Language English (U.S.); Bundle ID `dev.caprock.ios`; SKU
   `caprock-ios`; User Access Full Access.
4. **An API key for CI.** App Store Connect → **Users and Access** →
   **Integrations** → App Store Connect API → Team Keys → **+**. Name
   `caprock-ios-ci`, Access **App Manager**. Download the `.p8` (only
   possible once) and note the **Key ID** and the **Issuer ID** shown above
   the list. The key the Mac release already uses for notarization
   (`APPLE_API_KEY`, `APPLE_API_ISSUER`, `APPLE_API_KEY_P8`) can be reused
   instead if its access is App Manager or Admin.
5. **Hand them to GitHub, not to an agent.** Repository → Settings →
   Environments → new environment `ios-release` → secrets
   `APPSTORE_API_KEY_ID`, `APPSTORE_API_ISSUER_ID`, `APPSTORE_API_KEY_P8`
   (the file's contents) and `APPLE_TEAM_ID` (the same Team ID as the Mac
   app's). The signing job will read only these.
6. **TestFlight.** After the first upload: TestFlight → Internal Testing →
   **+** a group *Owner*, add yourself. Internal testers need no Beta App
   Review.
7. **Before submitting** (after the 3–5 days on TestFlight in ADR-083, an
   estimate):
   - **Export compliance:** the app encrypts its channel end to end with
     standard algorithms (Noise: X25519, ChaCha20-Poly1305). Answer the
     encryption questions once in App Store Connect; the answer then goes
     into `Info.plist` (`ITSAppUsesNonExemptEncryption`) so builds stop
     asking.
   - **App Privacy:** *Data Not Collected* matches ADR-083 (no tracking;
     speech on the device; the camera only reads the code). A privacy policy
     URL is required.
   - **Review notes:** "Tap **Try it without a Mac** on the first screen: the
     whole app on sample data, no account and no computer needed."
   - **Submit for Review.**
