// Caprock Mail, the Mac preview: one window with Mail and nothing else of
// Caprock, opened on the running Caprock daemon at <daemon>/?mail=1. The
// accounts and the mail are the daemon's, the same as in Caprock's Mail tab.
// It starts nothing and stores nothing; without a running Caprock it says so
// and waits for one. Built by build.sh; see README.md.

import Cocoa
import WebKit

// The daemon's data directory; $CAPROCK_DATA_DIR overrides it, as for the daemon.
let dataDir = ProcessInfo.processInfo.environment["CAPROCK_DATA_DIR"].map { URL(fileURLWithPath: $0) }
    ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/caprock")

/// The daemon's port from runtime.json, if a daemon there answers /healthz.
func daemonPort() -> Int? {
    guard let raw = try? Data(contentsOf: dataDir.appendingPathComponent("runtime.json")),
          let obj = try? JSONSerialization.jsonObject(with: raw) as? [String: Any],
          let port = obj["port"] as? Int,
          let url = URL(string: "http://127.0.0.1:\(port)/healthz") else { return nil }
    var req = URLRequest(url: url)
    req.timeoutInterval = 1.5
    let sem = DispatchSemaphore(value: 0)
    var ok = false
    URLSession.shared.dataTask(with: req) { _, resp, _ in
        ok = (resp as? HTTPURLResponse)?.statusCode == 200
        sem.signal()
    }.resume()
    _ = sem.wait(timeout: .now() + 2)
    return ok ? port : nil
}

let waitingPage = """
<!doctype html><meta charset=utf-8><style>
:root{color-scheme:light dark}body{margin:0;height:100vh;display:grid;place-items:center;
font:15px -apple-system,system-ui;background:#f6f4ee;color:#1d1e20}
@media (prefers-color-scheme:dark){body{background:#0e0f10;color:#e9e7e1}}
div{text-align:center;max-width:340px;line-height:1.5}b{display:block;font-size:17px;margin-bottom:6px}
</style><div><b>Caprock isn't running</b>Caprock Mail uses the mail in Caprock. Open Caprock, and this window fills in by itself.</div>
"""

final class Delegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var port: Int?
    var timer: Timer?

    func applicationDidFinishLaunching(_ note: Notification) {
        buildMenu()
        let cfg = WKWebViewConfiguration()
        cfg.preferences.setValue(true, forKey: "developerExtrasEnabled")
        web = WKWebView(frame: .zero, configuration: cfg)
        web.navigationDelegate = self
        web.uiDelegate = self
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1240, height: 800),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "Caprock Mail"
        window.minSize = NSSize(width: 720, height: 480)
        window.contentView = web
        window.center()
        window.setFrameAutosaveName("CaprockMailWindow")
        window.makeKeyAndOrderFront(nil)
        connect()
        // A Caprock restarted or updated may come back on another port.
        timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.recheck() }
    }

    func connect() {
        DispatchQueue.global().async {
            let p = daemonPort()
            DispatchQueue.main.async {
                self.port = p
                if let p = p, let url = URL(string: "http://127.0.0.1:\(p)/?mail=1") {
                    self.web.load(URLRequest(url: url))
                } else {
                    self.web.loadHTMLString(waitingPage, baseURL: nil)
                }
            }
        }
    }

    func recheck() {
        DispatchQueue.global().async {
            let p = daemonPort()
            DispatchQueue.main.async { if p != self.port { self.connect() } }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }

    // Links that leave the daemon open in the browser, like in Caprock.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.allow) }
        let ours = url.host == "127.0.0.1" && url.port == port
        if ours || url.scheme == "about" || url.scheme == "data" || url.scheme == "blob" {
            return decisionHandler(.allow)
        }
        if ["http", "https", "mailto"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, createWebViewWith cfg: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url {
            if url.host == "127.0.0.1" && url.port == port { webView.load(action.request) } else { NSWorkspace.shared.open(url) }
        }
        return nil
    }

    // An attachment link the page marks as a download is saved to Downloads.
    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(response.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    // A file picker for attachments in the composer.
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.beginSheetModal(for: window) { completionHandler($0 == .OK ? panel.urls : nil) }
    }

    func buildMenu() {
        let main = NSMenu()
        func item(_ title: String, _ sub: NSMenu) { let i = NSMenuItem(title: title, action: nil, keyEquivalent: ""); i.submenu = sub; main.addItem(i) }
        let app = NSMenu()
        app.addItem(withTitle: "Hide Caprock Mail", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        app.addItem(.separator())
        app.addItem(withTitle: "Quit Caprock Mail", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        item("Caprock Mail", app)
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        item("Edit", edit)
        let view = NSMenu(title: "View")
        view.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r")
        view.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f").keyEquivalentModifierMask = [.command, .control]
        item("View", view)
        let win = NSMenu(title: "Window")
        win.addItem(withTitle: "Minimize", action: #selector(NSWindow.miniaturize(_:)), keyEquivalent: "m")
        win.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        item("Window", win)
        NSApp.mainMenu = main
        NSApp.windowsMenu = win
    }

    @objc func reload() { connect() }
}

extension Delegate: WKDownloadDelegate {
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let dir = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
        var dest = dir.appendingPathComponent(suggestedFilename)
        var n = 1
        let base = dest.deletingPathExtension().lastPathComponent, ext = dest.pathExtension
        while FileManager.default.fileExists(atPath: dest.path) {
            dest = dir.appendingPathComponent(ext.isEmpty ? "\(base) \(n)" : "\(base) \(n).\(ext)")
            n += 1
        }
        completionHandler(dest)
    }

    func downloadDidFinish(_ download: WKDownload) {
        if let url = download.progress.fileURL { NSWorkspace.shared.activateFileViewerSelecting([url]) }
    }
}

let app = NSApplication.shared
let delegate = Delegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
