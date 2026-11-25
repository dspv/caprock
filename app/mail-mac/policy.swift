// Where a navigation in the Caprock Mail window goes. Kept apart from the
// window code and free of WebKit so policy_test.swift can check it with
// swiftc alone (test.sh; build.sh runs it before building).
//
// The rule matches the desktop app's Mail window (app/src-tauri/src/shell.rs,
// `navigation`), with one more guard: only a click goes to the browser.
//
// Why: the window reloads itself — after a Caprock update the page reloads
// onto the new UI (ui/src/lib/staleui.ts) — and that reload can land while
// the daemon is restarting, when this app has no daemon to compare the
// address with. Handing that reload to the system browser opened a stray
// "Caprock Mail" tab in the browser after updates, again and again (owner,
// 2026-11-25). A page on 127.0.0.1 with no daemon, or on the port the page
// was loaded from, is the window's own page: it is refused, nothing opens.

import Foundation

enum Route: Equatable {
    /// Load it in the window: the daemon's page, about:, data:, blob:.
    case stay
    /// Refuse it and open nothing.
    case drop
    /// Refuse it here and open it in the system browser or mail app.
    case browser
}

/// - `daemonPort`: the port of the daemon that answers now; nil while none does.
/// - `pagePort`: the port the window last loaded the daemon's page from; kept
///   while the daemon is away, so the page's own reload is still recognised.
/// - `userClick`: the navigation is a link the user activated, or a window
///   the page opened on a click (WebKit opens none without one).
func route(_ url: URL?, daemonPort: Int?, pagePort: Int?, userClick: Bool) -> Route {
    guard let url = url, let scheme = url.scheme?.lowercased() else { return .stay }
    if ["about", "data", "blob"].contains(scheme) { return .stay }
    if scheme == "http" && url.host == "127.0.0.1" {
        if let d = daemonPort, url.port == d { return .stay }
        // The window reloading itself while the daemon restarts or after it
        // moved: never a browser tab.
        if daemonPort == nil || (pagePort != nil && url.port == pagePort) { return .drop }
    }
    if userClick && ["http", "https", "mailto"].contains(scheme) { return .browser }
    return .drop
}
