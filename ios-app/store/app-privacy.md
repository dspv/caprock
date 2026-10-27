# App Privacy answers (App Store Connect → App Privacy)

**Answer: Data Not Collected.** In App Store Connect: *Do you or your
third-party partners collect data from this app?* → **No, we do not collect
data from this app.** Privacy Policy URL: `https://caprock.dev/privacy`.

Apple's definition: data is *collected* when it is transmitted off the device
in a way that lets the developer or a third party access it for longer than
it takes to serve the request in real time
(developer.apple.com/app-store/app-privacy-details). Checked against the code
on 2026-10-27:

- **Where the app connects.** The page the app shows is bundled
  (`capacitor://localhost`); `CapacitorHttp` is off. After pairing, every
  request for data goes to the paired computer through the channel in
  `ui/src/remote/transport.ts`: one WebSocket to the relay named in the pairing
  link (`wss://` only, `remote/boot.ts` `relayAllowed`), with a Noise session
  (X25519, AES-256-GCM, SHA-256) inside it, so the relay forwards ciphertext.
  The relay keeps nothing: it sees which machine a phone connects to, when,
  from which IP address and how many bytes, and stores none of it
  (caprock.dev/privacy, ADR-058). That is serving the request in real time,
  not collection.
- **The user's computer is not the developer.** What the phone reads and
  sends (sessions, messages, approvals) goes to the user's own Caprock on the
  user's own machine.
- **The demo** answers from bundled sample data and sends nothing
  (`ui/src/native/demo/`).
- **No third-party SDKs that collect.** The native plugins are Capacitor's
  shell, keyboard, app lifecycle and barcode scanner (Apple's camera, read on
  the device), a speech plugin with on-device recognition required, a
  biometric plugin (Face ID or the passcode, answered by iOS) and a Keychain
  plugin. No analytics, crash reporting or advertising library is in the app
  or in the bundled page (no Umami, Sentry or similar in `ui/dist-remote`).
- **Speech** is recognised on the iPhone; when a language cannot be
  recognised on the device, nothing is recorded or sent
  (`ui/src/native/speech.ts`).
- **Links that open elsewhere.** The bundled page contains ordinary links (a
  GitHub page, caprock.dev pages) that open in Safari when tapped. Opening a
  web page in Safari is not collection by the app.
- **A bug report or survey answer written on the phone** goes to the paired
  computer (`POST /v1/support` on its daemon), and from the computer to
  Caprock support only when the user presses Send there; it is user-initiated,
  optional and infrequent, which Apple lists as optional to disclose. If a
  future version sends anything from the phone itself, these answers change
  with it.

**Tracking:** No. The app does not link data with other companies' data and
does not share data with data brokers.

**Before each new version,** look again for a new outbound call: any `fetch`,
`WebSocket` or plugin that reaches a host other than the paired relay.
