import AppKit
import SwiftTerm
import SwiftUI

/// A native terminal attached to the daemon's existing PTY socket,
/// `WS /v1/agents/{id}/term` — the same endpoint, frames and resize message
/// the web Terminal.tsx uses: binary frames are keystrokes, a text frame
/// `{"resize":{"cols":N,"rows":N}}` is the size, and the daemon replays a
/// snapshot on connect.
final class CaprockTerminalView: TerminalView, TerminalViewDelegate {
    let sessionID: String
    let base: URL
    let token: String
    private var task: URLSessionWebSocketTask?
    private var session: URLSession?
    var bench: Bench?
    private(set) var gotOutput = false

    init(frame: CGRect, sessionID: String, base: URL, token: String) {
        self.sessionID = sessionID
        self.base = base
        self.token = token
        super.init(frame: frame, font: NSFont.monospacedSystemFont(ofSize: 12, weight: .regular))
        terminalDelegate = self
        // Graphite, like the web terminal's fixed palette.
        nativeBackgroundColor = NSColor(srgbRed: 0x0b / 255, green: 0x0e / 255, blue: 0x14 / 255, alpha: 1)
        nativeForegroundColor = NSColor(srgbRed: 0xd3 / 255, green: 0xda / 255, blue: 0xe3 / 255, alpha: 1)
        caretColor = NSColor(srgbRed: 0x5e / 255, green: 0xa1 / 255, blue: 0xff / 255, alpha: 1)
        optionAsMetaKey = true
        notifyUpdateChanges = true
        registerForDraggedTypes([.fileURL])
        connect()
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    deinit { task?.cancel(with: .goingAway, reason: nil) }

    // MARK: socket

    private func connect() {
        var c = URLComponents(url: base, resolvingAgainstBaseURL: false)!
        c.scheme = "ws"
        c.path = "/v1/agents/\(sessionID)/term"
        var req = URLRequest(url: c.url!)
        // The upgrade is guarded by an Origin allow-list (loopback only) — the
        // browser sends its page's origin, so we send the daemon's own.
        req.setValue("http://127.0.0.1:\(base.port ?? 0)", forHTTPHeaderField: "Origin")
        let s = URLSession(configuration: .default)
        session = s
        let t = s.webSocketTask(with: req)
        t.maximumMessageSize = 16 << 20
        task = t
        t.resume()
        sendSize()
        receive()
    }

    private func receive() {
        task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure:
                DispatchQueue.main.async { self.feed(text: "\r\n\u{1b}[2m[session ended]\u{1b}[0m\r\n") }
            case .success(let msg):
                let bytes: [UInt8]
                switch msg {
                case .data(let d): bytes = [UInt8](d)
                case .string(let s): bytes = [UInt8](s.utf8)
                @unknown default: bytes = []
                }
                let arrived = ProcessInfo.processInfo.systemUptime
                DispatchQueue.main.async {
                    self.gotOutput = true
                    // Marked before feeding: SwiftTerm may update the display
                    // inside feed() when the user has just typed.
                    if self.bench?.sawBytes(bytes, at: arrived) == true { self.bench?.fed() }
                    self.feed(byteArray: bytes[...])
                }
                self.receive()
            }
        }
    }

    func sendBytes(_ data: Data) {
        task?.send(.data(data)) { _ in }
    }

    func sendSize() {
        let t = getTerminal()
        guard t.cols > 0, t.rows > 0 else { return }
        task?.send(.string("{\"resize\":{\"cols\":\(t.cols),\"rows\":\(t.rows)}}")) { _ in }
    }

    // MARK: TerminalViewDelegate

    func send(source: TerminalView, data: ArraySlice<UInt8>) { bench?.sent(); sendBytes(Data(data)) }
    func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) { sendSize() }
    func setTerminalTitle(source: TerminalView, title: String) {}
    func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
    func scrolled(source: TerminalView, position: Double) {}
    func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
        if let u = URL(string: link) { NSWorkspace.shared.open(u) }
    }
    func bell(source: TerminalView) {}
    func clipboardCopy(source: TerminalView, content: Data) {
        if let s = String(data: content, encoding: .utf8) {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(s, forType: .string)
        }
    }
    func clipboardRead(source: TerminalView) -> Data? { nil }
    func iTermContent(source: TerminalView, content: ArraySlice<UInt8>) {}
    func rangeChanged(source: TerminalView, startY: Int, endY: Int) { bench?.displayed() }

    // MARK: paste and drop a file → POST /v1/paste → its path, typed

    override func paste(_ sender: Any) {
        let pb = NSPasteboard.general
        if let urls = pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL], !urls.isEmpty {
            upload(urls.compactMap { u in (try? Data(contentsOf: u)).map { (u.lastPathComponent, $0) } })
            return
        }
        if pb.string(forType: .string) == nil, let img = NSImage(pasteboard: pb),
           let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
           let png = rep.representation(using: .png, properties: [:]) {
            upload([("pasted.png", png)])
            return
        }
        super.paste(sender)
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation { .copy }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        guard let urls = sender.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] else { return false }
        upload(urls.compactMap { u in (try? Data(contentsOf: u)).map { (u.lastPathComponent, $0) } })
        return true
    }

    private func upload(_ files: [(String, Data)]) {
        let base = self.base, token = self.token
        Task {
            for (name, data) in files {
                do {
                    let path = try await Daemon.pasteStatic(name: name, data: data, base: base, token: token)
                    // Quoted: the macOS data dir has a space in it.
                    await MainActor.run { self.sendBytes(Data("\"\(path)\" ".utf8)) }
                } catch {
                    await MainActor.run { self.feed(text: "\r\n\u{1b}[33m[caprock: \(name): \(error.localizedDescription)]\u{1b}[0m\r\n") }
                }
            }
        }
    }
}

extension Daemon {
    nonisolated static func pasteStatic(name: String, data: Data, base: URL, token: String) async throws -> String {
        var req = URLRequest(url: base.appendingPathComponent("/v1/paste"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["name": name, "type": "", "data": data.base64EncodedString()])
        let (body, resp) = try await URLSession.shared.data(for: req)
        let obj = try JSONSerialization.jsonObject(with: body) as? [String: Any]
        if let path = obj?["path"] as? String { return path }
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        throw NSError(domain: "caprock", code: code, userInfo: [NSLocalizedDescriptionKey: (obj?["error"] as? String) ?? "paste refused (\(code))"])
    }
}

/// Shift/Ctrl+Enter and Ctrl+J → ESC CR, the bytes Claude Code reads as a new
/// line in the prompt (see the long note in ui/src/components/Terminal.tsx).
/// Option+Enter already sends ESC CR with optionAsMetaKey. SwiftTerm's keyDown
/// is not overridable, so this is a local event monitor.
enum NewlineKeys {
    static var installed = false
    static func install() {
        guard !installed else { return }
        installed = true
        NSEvent.addLocalMonitorForEvents(matching: .keyDown) { ev in
            guard let term = ev.window?.firstResponder as? CaprockTerminalView else { return ev }
            let mods = ev.modifierFlags.intersection([.shift, .control, .option, .command])
            let isEnter = ev.keyCode == 36 || ev.keyCode == 76
            if (isEnter && (mods == .shift || mods == .control)) || (mods == .control && ev.charactersIgnoringModifiers == "j") {
                term.sendBytes(Data([0x1b, 0x0d]))
                return nil
            }
            return ev
        }
    }
}

struct TerminalPane: NSViewRepresentable {
    let session: SessionRow
    let base: URL
    let token: String

    func makeNSView(context: Context) -> CaprockTerminalView {
        NewlineKeys.install()
        let v = CaprockTerminalView(frame: .init(x: 0, y: 0, width: 900, height: 600), sessionID: session.session_id, base: base, token: token)
        DispatchQueue.main.async {
            v.window?.makeFirstResponder(v)
            Bench.attachIfRequested(v)
        }
        return v
    }

    func updateNSView(_ nsView: CaprockTerminalView, context: Context) {}
}
