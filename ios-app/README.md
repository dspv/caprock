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
  scripts/check-store.mjs     # the store texts fit Apple's limits (CI runs it)
  scripts/app-store.sh        # archive, sign, upload (ios-release.yml runs it; CI only)
  store/                  # the App Store listing, pasted into App Store Connect by hand
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

To run it in the Simulator rather than only compile it, sign it ad hoc
(`CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM=` in place of
`CODE_SIGNING_ALLOWED=NO`): an unsigned app has no Keychain in the Simulator,
so turning on the lock fails with *The Keychain did not take the change* and
the pairing is not kept. The Simulator has no camera, so the scanner opens
only on a real iPhone; check pairing by the camera on one before submitting.

After changing a plugin, run `npx cap sync ios` and commit the rewritten
`CapApp-SPM/Package.swift`; CI fails when the committed one is stale. The
Swift packages the plugins pull in (`capacitor-swift-pm`, `keychain-swift`,
`OSBarcodeLib-iOS`) are pinned by the committed
`App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved`,
which CI builds with `-onlyUsePackageVersionsFromResolvedFile`; a plugin
update that needs other versions fails there, and the failed run prints what
it resolved.


## Version 1.0: what is in it and what is not

1.0 goes straight to App Store review, with no TestFlight round, and without
push (owner, 2026-10-27; ADR-083 amended). It asks for no notification
permission, registers for no remote notifications and has no
`aps-environment` entitlement; the App ID's Push Notifications capability is
ticked but unused until 1.1.

Not in 1.0:

- **Push notifications** ("Claude is waiting for your answer", "task done"):
  1.1, with `OQ-24` (what a push may carry) and the sender service.
- **Get the app** on `m.caprock.dev`, once the app is in the App Store.

## Release

`.github/workflows/ios-release.yml`, run by hand (Actions → ios-release →
Run workflow), never on a push or a tag. It runs on `macos-latest` in the
`ios-release` environment, builds the phone's page in remote mode, syncs it
in, and runs `scripts/app-store.sh`:

1. **Archive** a Release build for `generic/platform=iOS`, unsigned
   (`CODE_SIGNING_ALLOWED=NO`), with `MARKETING_VERSION` from the run's
   *version* input (default `1.0`) and `CURRENT_PROJECT_VERSION` = the
   workflow's run number, so every upload has a higher build number. The
   archive is unsigned on purpose: a signed archive needs an Apple
   Development certificate and a development profile, and Apple issues a
   development profile only for a team with a registered device.
2. **Export** with `xcodebuild -exportArchive -allowProvisioningUpdates
   -authenticationKeyPath/-authenticationKeyID/-authenticationKeyIssuerID`
   and an `ExportOptions.plist` the script writes: `method`
   `app-store-connect`, `destination` `upload`, `teamID`, `signingStyle`
   `automatic`. Xcode signs the app for the App Store and uploads it in the
   same step; the build appears in App Store Connect after processing.
   *destination: export* stops at a signed `.ipa`, kept 7 days as the run's
   artifact with the logs, and uploads nothing.

Submitting the build for review is a click in App Store Connect, not the
workflow's.

## Signing

There is no distribution certificate or profile in the repository's secrets;
the Mac app's Developer ID certificate cannot sign an iOS app. Two ways, and
the workflow's *signing* input picks one (`auto`: the certificate when its
secret is there, else cloud):

- **Cloud signing, with the API key alone.** Xcode signs with a
  cloud-managed Apple Distribution certificate that Apple keeps, and creates
  the App Store profile itself. **It needs a Team key with the Admin role.**
  Apple's help gives cloud-managed certificates to Account Holders and Admins
  and to users given the separate permission in Users and Access
  (developer.apple.com/help/account/certificates/cloud-managed-certificates);
  an API key has no such switch, and a key's role is fixed when it is made.
  With an App Manager or Developer key, the export fails with *Cloud signing
  permission error: You haven't been given access to cloud-managed
  distribution certificates* (reported on the Apple Developer Forums, thread
  698117; the script names this error and the two ways out). The key in
  `ios-release` today is App Manager.
- **A certificate the owner makes once.** An Apple Distribution certificate
  and its private key as a `.p12` in two more secrets of `ios-release`:
  `IOS_DIST_CERT_P12` (the file, base64) and `IOS_DIST_CERT_PASSWORD`. The
  script imports it into a throwaway keychain, and the App Manager key lets
  Xcode fetch or create the App Store profile for `dev.caprock.ios`. If that
  key is refused the profile too, a third secret, `IOS_PROFILE_B64` (an App
  Store profile for `dev.caprock.ios`, base64), switches the export to manual
  signing and nothing is created.

**What the owner does, one of:**

- **A (fewest steps): a new Admin key.** App Store Connect → Users and
  Access → Integrations → App Store Connect API → Team Keys → **+**, Name
  `caprock-ios-release`, Access **Admin** → Generate → Download (once). In
  GitHub → Settings → Environments → `ios-release`, replace
  `APPSTORE_API_KEY_ID`, `APPSTORE_API_KEY_P8` (the file's text) and, if it
  differs, `APPSTORE_API_ISSUER_ID`. Then revoke the App Manager key if
  nothing else uses it. Admin is a broad key: it lives only in that
  environment.
- **B (keeps the App Manager key): one Apple Distribution certificate.** On
  the Mac: Keychain Access → Certificate Assistant → Request a Certificate
  From a Certificate Authority → saved to disk. developer.apple.com →
  Certificates → **+** → Apple Distribution → upload the request → download
  and open the `.cer`. In Keychain Access, under My Certificates, export
  *Apple Distribution: CYBRIX LLC* as a `.p12` with a password. In GitHub's
  `ios-release` environment add `IOS_DIST_CERT_P12` (`base64 -i dist.p12 |
  pbcopy`) and `IOS_DIST_CERT_PASSWORD`. (Only if the first run then says
  the profile could not be made: Profiles → **+** → App Store Connect → App
  ID `dev.caprock.ios` → the new certificate → download, and add it as
  `IOS_PROFILE_B64`.)

## Export compliance

`Info.plist` sets `ITSAppUsesNonExemptEncryption` to **true**. The app's
channel to the computer is Noise_NK_25519_AESGCM_SHA256 (X25519, AES-256-GCM,
SHA-256; `ui/src/remote/noise.ts`), implemented in the app with `@noble`, not
Apple's crypto: it is synchronous on purpose, so WebCrypto is not a drop-in.
Apple's table (App Store Connect Help → Export compliance documentation for
encryption) has three rows: encryption limited to Apple's operating system
needs no documentation; *an industry standard algorithm, not provided within
the Apple operating system* needs a **French encryption declaration**
uploaded in App Store Connect, and only if the app is offered in France;
proprietary algorithms need a US CCATS as well. Caprock is the middle row,
which `false` would misstate.

What follows for 1.0, at the first submission (App Store Connect asks the
questions because the key is true):

- *Does your app use encryption?* **Yes**. Algorithms: **standard
  algorithms instead of, or in addition to, Apple's operating system**. Not
  proprietary.
- **France:** either take France out of the app's availability for 1.0 (no
  document needed), or file the declaration with ANSSI and upload it. The
  first is the quick path; France can be added back once the declaration is
  accepted.
- Once Apple approves any documentation it gives a code; setting it as
  `ITSEncryptionExportComplianceCode` in `Info.plist` stops the questions on
  later builds.

Rule 4 is unchanged: the encryption protects the user's own traffic to the
user's own computer.

## Screenshots

The App Store needs iPhone screenshots for the 6.9-inch display, 1320 × 2868
portrait (or 1290 × 2796), up to ten; Apple scales them down for smaller
iPhones. Make them in the Simulator on an iPhone of that size (an iPhone 18
Pro Max under Xcode 27 is 1320 × 2868), in demo mode, with the status bar
set to 9:41 (`xcrun simctl status_bar booted override --time 9:41
--batteryState charged --batteryLevel 100 --wifiBars 3 --cellularBars 4`),
and `xcrun simctl io booted screenshot`. They are not committed.

## The App Store listing

`store/` holds what is pasted into App Store Connect: [listing.md](store/listing.md)
(name, subtitle, keywords, URLs, category), the description, the promotional
text, [the App Privacy answers](store/app-privacy.md) (Data Not Collected,
and why), [the age rating answers](store/age-rating.md) and
[the review notes](store/review-notes.txt). `node scripts/check-store.mjs`
checks each field against Apple's limits.

## The owner's steps in App Store Connect

Done already (2026-10-27): the agreements, the App ID `dev.caprock.ios` with
Push Notifications ticked, the app record *Caprock* (SKU `caprock-ios`), a
Team API key with App Manager access, and the `ios-release` environment with
`APPSTORE_API_KEY_ID`, `APPSTORE_API_ISSUER_ID`, `APPSTORE_API_KEY_P8` and
`APPLE_TEAM_ID`.

Still his:

1. **Signing:** A or B under [Signing](#signing).
2. **Run the workflow** (Actions → ios-release → Run workflow, version
   `1.0`, destination `upload`), or have the lead run it.
3. **Version 1.0's page** in App Store Connect: paste `store/`, upload the
   screenshots, choose the build once it has processed.
4. **App Privacy:** *Data Not Collected* ([store/app-privacy.md](store/app-privacy.md));
   privacy policy URL `https://caprock.dev/privacy`.
5. **Export compliance and France:** as under
   [Export compliance](#export-compliance).
6. **Submit for Review.**
