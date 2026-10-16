# Caprock Mail — the Mac preview

A separate Mac app for trying Caprock Mail on its own: one window with the
inbox and nothing else of Caprock — no sidebar, no tabs. It opens the running
Caprock daemon's `<daemon>/?mail=1` page in a WebKit window, so the accounts
and the mail are the same as in Caprock's Mail ([ADR-057](../../.ai/08-decisions.md)).

The Caprock desktop app opens it: installed in `/Applications` or
`~/Applications`, the sidebar's *Mail*, ⇧⌘M and the palette's *Open Mail*
launch this app or bring it forward instead of opening Mail inside Caprock's
window (the app's `open_mail_app`, [app/README.md](../README.md) § What a page
may call). Without it the desktop app opens its own *Caprock Mail* window on
the same page. The app is recognised by its bundle id,
`dev.caprock.mail.preview`, so keep it when rebuilding.

It starts nothing and stores nothing of its own. Without a running Caprock it
says so and fills in when Caprock starts; a Caprock updated or restarted, on
the same port or another, is picked up from `runtime.json` within a few
seconds and the page reloads onto its UI. Closing the window keeps the app in
the Dock, like Mail.app; a click on the icon brings the window back. Links that leave the
daemon open in the browser; attachments save to Downloads.

This is a preview for this machine, not a release: it is signed ad hoc, needs
an installed Caprock new enough to serve `?mail=1`, and is not built by CI.
Mail as its own product, without Caprock, is a later decision.

## Build

```sh
app/mail-mac/build.sh        # → app/mail-mac/build/Caprock Mail.app
```

Needs the Xcode command line tools (`swiftc`, `iconutil`) and `rsvg-convert`
(`brew install librsvg`). Copy the app to `/Applications` to keep it in the
Dock. `CAPROCK_DATA_DIR` points it at another daemon's data directory, as for
the daemon (preview daemons).

The icon is Caprock's, with an envelope in the C's mouth instead of the dot:
`icon.svg`, rendered into `AppIcon.icns` by `build.sh`.
