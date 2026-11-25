// Checks policy.swift: nothing reaches the browser without a click, and the
// window's own page never does. Run by test.sh (and build.sh before building).

import Foundation

var failures = 0

func expect(_ got: Route, _ want: Route, _ what: String) {
    if got != want {
        failures += 1
        print("FAIL \(what): got \(got), want \(want)")
    }
}

let page = URL(string: "http://127.0.0.1:4173/?mail=1")!
let web = URL(string: "https://example.com/news")!

// The daemon's own page stays in the window, clicked or not.
expect(route(page, daemonPort: 4173, pagePort: 4173, userClick: false), .stay, "own page, daemon up")
expect(route(page, daemonPort: 4173, pagePort: 4173, userClick: true), .stay, "own page clicked, daemon up")

// The page reloading itself while the daemon restarts after an update: no
// browser tab, whether this app had already seen the daemon go or not.
expect(route(page, daemonPort: nil, pagePort: 4173, userClick: false), .drop, "reload, daemon away")
expect(route(page, daemonPort: nil, pagePort: nil, userClick: false), .drop, "reload, no daemon seen yet")
expect(route(page, daemonPort: nil, pagePort: 4173, userClick: true), .drop, "own page clicked, daemon away")

// A daemon back on another port: the old page's reload is not a link.
expect(route(page, daemonPort: 4174, pagePort: 4173, userClick: false), .drop, "reload on the old port")

// Nothing goes to the browser without a click: a redirect, a refresh or a
// script navigation to the web is refused quietly.
expect(route(web, daemonPort: 4173, pagePort: 4173, userClick: false), .drop, "web, no click")
expect(route(web, daemonPort: nil, pagePort: 4173, userClick: false), .drop, "web, no click, daemon away")
expect(route(URL(string: "https://accounts.google.com/o/oauth2/v2/auth?x=1")!, daemonPort: 4173, pagePort: 4173, userClick: false),
       .drop, "a sign-in page, no click")

// A click on a link does open the browser (or the mail app).
expect(route(web, daemonPort: 4173, pagePort: 4173, userClick: true), .browser, "web link clicked")
expect(route(URL(string: "https://accounts.google.com/o/oauth2/v2/auth?x=1")!, daemonPort: 4173, pagePort: 4173, userClick: true),
       .browser, "Sign in again clicked")
expect(route(URL(string: "mailto:a@example.com")!, daemonPort: 4173, pagePort: 4173, userClick: true), .browser, "mailto clicked")
expect(route(URL(string: "http://127.0.0.1:5173/")!, daemonPort: 4173, pagePort: 4173, userClick: true), .browser, "another local port clicked")

// Other schemes never leave; the window's own documents stay.
expect(route(URL(string: "file:///etc/hosts")!, daemonPort: 4173, pagePort: 4173, userClick: true), .drop, "file clicked")
expect(route(URL(string: "about:blank")!, daemonPort: nil, pagePort: nil, userClick: false), .stay, "about:blank")
expect(route(URL(string: "data:text/html,hi")!, daemonPort: 4173, pagePort: 4173, userClick: false), .stay, "data:")
expect(route(nil, daemonPort: 4173, pagePort: 4173, userClick: false), .stay, "no url")

if failures > 0 {
    print("\(failures) failed")
    exit(1)
}
print("policy: ok")
