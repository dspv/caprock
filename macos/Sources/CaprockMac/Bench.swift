import AppKit
import Carbon.HIToolbox

/// The spike's typing benchmark, on only when `--bench-out <file>` is passed.
///
/// It drives the real AppKit key path: each keystroke is an NSEvent posted to
/// the application queue (NSApp.postEvent), so it goes through sendEvent →
/// SwiftTerm's keyDown → interpretKeyEvents → the socket, like a typed key.
/// The fake `claude` on the other side (raw mode) redraws its input row as
/// "> <typed>" on every byte, so the benchmark knows exactly what to wait for.
///
/// Per key it records, against the event's own timestamp:
///   socket — the echo's bytes arrived from the daemon;
///   paint  — those bytes were fed to the emulator, SwiftTerm updated the
///            display (rangeChanged), and the main run loop then passed its
///            before-waiting point, which is where AppKit commits the frame
///            (our observer runs at the highest order, after Core Animation's).
/// That is "frame handed to the window server", not photons; the web
/// benchmark stops at the same point (rAF + a task after it).
final class Bench {
    static var attached = false
    static func attachIfRequested(_ v: CaprockTerminalView) {
        guard !attached, let out = Args.value("--bench-out") else { return }
        attached = true
        // Match the web terminal's grid: the window size is a benchmark input.
        if let size = Args.value("--bench-size")?.split(separator: "x").compactMap({ Double($0) }), size.count == 2 {
            v.window?.setContentSize(NSSize(width: size[0], height: size[1]))
        }
        var renderer = "coregraphics"
        if CommandLine.arguments.contains("--bench-metal") {
            do { try v.setUseMetal(true); renderer = "metal" } catch { renderer = "coregraphics (metal failed: \(error))" }
        }
        let b = Bench(view: v, out: out, keys: Int(Args.value("--bench-keys") ?? "") ?? 60)
        b.result["renderer"] = renderer
        b.watchSeconds = Double(Args.value("--bench-watch") ?? "") ?? 20
        v.bench = b
        b.start()
    }

    let view: CaprockTerminalView
    let out: String
    let keys: Int
    let paneCreated = ProcessInfo.processInfo.systemUptime
    var observer: CFRunLoopObserver?

    // the key in flight
    var expected: [UInt8] = []
    var buffer: [UInt8] = []
    var keyAt: TimeInterval = 0
    var socketAt: TimeInterval?
    var echoFed = false
    var displayedAfterFeed = false
    var done: ((TimeInterval, TimeInterval) -> Void)?

    var socketMs: [Double] = []
    var paintMs: [Double] = []
    var result: [String: Any] = [:]
    var watchSeconds: Double = 20

    init(view: CaprockTerminalView, out: String, keys: Int) {
        self.view = view
        self.out = out
        self.keys = keys
    }

    func start() {
        let obs = CFRunLoopObserverCreateWithHandler(kCFAllocatorDefault, CFRunLoopActivity.beforeWaiting.rawValue, true, CFIndex.max) { [weak self] _, _ in
            self?.afterCommit()
        }
        CFRunLoopAddObserver(CFRunLoopGetMain(), obs, .commonModes)
        observer = obs
        firstEcho()
    }

    // MARK: phase 1 — time to the first echoed keystroke

    func firstEcho() {
        let nonce = (0..<4).map { _ in String("abcdefghijklmnopqrstuvwyz".randomElement()!) }.joined()
        var echoed = false
        expect(Array(nonce.utf8)) { sock, paint in
            echoed = true
            let procStart = Bench.processStartUptime()
            self.result["pane_to_first_echo_paint_ms"] = (paint - self.paneCreated) * 1000
            self.result["launch_to_first_echo_paint_ms"] = procStart.map { (paint - $0) * 1000 } as Any
            self.result["pane_to_first_echo_socket_ms"] = (sock - self.paneCreated) * 1000
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self.steady(0) }
        }
        // A user who starts typing at once: the nonce every 100 ms until it shows.
        func attempt() {
            guard !echoed else { return }
            for c in nonce { self.key(c) }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1, execute: attempt)
        }
        attempt()
    }

    // MARK: phase 2 — steady echo latency

    var typed = ""
    func steady(_ i: Int) {
        if i >= keys { finish(); return }
        if i % 20 == 0 {
            // Enter clears the fake's input row; untimed.
            buffer = []; expected = []
            key("\r")
            typed = ""
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { self.steadyKey(i) }
            return
        }
        steadyKey(i)
    }

    func steadyKey(_ i: Int) {
        let c = Character(String("abcdefghijklmnopqrstuvwxyz".randomElement()!))
        typed.append(c)
        // "\u{1b}" closes the row: "> ab" must not match while "> abc" is due.
        expect(Array("> \(typed)\u{1b}".utf8)) { sock, paint in
            self.socketMs.append((sock - self.keyAt) * 1000)
            self.paintMs.append((paint - self.keyAt) * 1000)
            let jitter = Double.random(in: 0.12...0.2)
            DispatchQueue.main.asyncAfter(deadline: .now() + jitter) { self.steady(i + 1) }
        }
        key(c)
        // A lost key would stall the run: give up on it after 3 s.
        let stamp = keyAt
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
            if self.keyAt == stamp, self.done != nil {
                self.result["timeouts"] = ((self.result["timeouts"] as? Int) ?? 0) + 1
                self.done = nil
                self.steady(i + 1)
            }
        }
    }

    // MARK: plumbing

    func expect(_ bytes: [UInt8], then: @escaping (TimeInterval, TimeInterval) -> Void) {
        expected = bytes
        buffer = []
        socketAt = nil
        sentAt = nil
        echoFed = false
        displayedAfterFeed = false
        done = then
    }

    static let keyCodes: [Character: Int] = [
        "a": kVK_ANSI_A, "b": kVK_ANSI_B, "c": kVK_ANSI_C, "d": kVK_ANSI_D, "e": kVK_ANSI_E, "f": kVK_ANSI_F,
        "g": kVK_ANSI_G, "h": kVK_ANSI_H, "i": kVK_ANSI_I, "j": kVK_ANSI_J, "k": kVK_ANSI_K, "l": kVK_ANSI_L,
        "m": kVK_ANSI_M, "n": kVK_ANSI_N, "o": kVK_ANSI_O, "p": kVK_ANSI_P, "q": kVK_ANSI_Q, "r": kVK_ANSI_R,
        "s": kVK_ANSI_S, "t": kVK_ANSI_T, "u": kVK_ANSI_U, "v": kVK_ANSI_V, "w": kVK_ANSI_W, "x": kVK_ANSI_X,
        "y": kVK_ANSI_Y, "z": kVK_ANSI_Z, "\r": kVK_Return,
    ]

    func key(_ c: Character) {
        guard let win = view.window else { return }
        if win.firstResponder !== view { win.makeFirstResponder(view) }
        let now = ProcessInfo.processInfo.systemUptime
        keyAt = now
        let s = String(c)
        let code = UInt16(Bench.keyCodes[c] ?? 0)
        for type in [NSEvent.EventType.keyDown, .keyUp] {
            if let ev = NSEvent.keyEvent(with: type, location: .zero, modifierFlags: [], timestamp: now,
                                         windowNumber: win.windowNumber, context: nil, characters: s,
                                         charactersIgnoringModifiers: s, isARepeat: false, keyCode: code) {
                NSApp.postEvent(ev, atStart: false)
            }
        }
    }

    /// Called on main with each chunk, before it is fed. True when this chunk completes the echo.
    func sawBytes(_ bytes: [UInt8], at: TimeInterval) -> Bool {
        guard done != nil, socketAt == nil, !expected.isEmpty else { return false }
        buffer.append(contentsOf: bytes)
        if buffer.count > 65536 { buffer.removeFirst(buffer.count - 65536) }
        if contains(buffer, expected) {
            socketAt = at
            return true
        }
        return false
    }

    var sentAt: TimeInterval?, fedAt: TimeInterval = 0, displayedAt: TimeInterval = 0
    var stages: [String: [Double]] = [:]
    func sent() { if sentAt == nil, done != nil { sentAt = ProcessInfo.processInfo.systemUptime } }
    func fed() { echoFed = true; fedAt = ProcessInfo.processInfo.systemUptime }
    func displayed() { if echoFed && !displayedAfterFeed { displayedAfterFeed = true; displayedAt = ProcessInfo.processInfo.systemUptime } }

    func afterCommit() {
        guard displayedAfterFeed, let sock = socketAt, let then = done else { return }
        let paint = ProcessInfo.processInfo.systemUptime
        done = nil
        if let sentAt {
            for (k, v) in [("key_to_send", sentAt - keyAt), ("send_to_socket", sock - sentAt), ("socket_to_fed", fedAt - sock),
                           ("fed_to_display", displayedAt - fedAt), ("display_to_commit", paint - displayedAt)] {
                stages[k, default: []].append(v * 1000)
            }
        }
        then(sock, paint)
    }

    func contains(_ hay: [UInt8], _ needle: [UInt8]) -> Bool {
        guard needle.count <= hay.count else { return false }
        let first = needle[0]
        var i = 0
        while i <= hay.count - needle.count {
            if hay[i] == first && Array(hay[i..<(i + needle.count)]) == needle { return true }
            i += 1
        }
        return false
    }

    static func usage() -> (cpu: Double, rssMB: Double) {
        var ru = rusage()
        getrusage(RUSAGE_SELF, &ru)
        let cpu = Double(ru.ru_utime.tv_sec + ru.ru_stime.tv_sec) + Double(ru.ru_utime.tv_usec + ru.ru_stime.tv_usec) / 1e6
        var info = mach_task_basic_info()
        var count = mach_msg_type_number_t(MemoryLayout<mach_task_basic_info>.size / MemoryLayout<natural_t>.size)
        let kr = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), $0, &count) }
        }
        return (cpu, kr == KERN_SUCCESS ? Double(info.resident_size) / 1048576 : .nan)
    }

    /// Phase 3: watch the stream without typing; this process's CPU and RSS.
    func finish() {
        let a = Bench.usage(), wa = ProcessInfo.processInfo.systemUptime
        var peak = a.rssMB
        for k in 1...max(1, Int(watchSeconds)) {
            DispatchQueue.main.asyncAfter(deadline: .now() + Double(k)) { peak = max(peak, Bench.usage().rssMB) }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + watchSeconds + 0.05) {
            let b = Bench.usage(), wb = ProcessInfo.processInfo.systemUptime
            self.result["watch_s"] = (wb - wa).rounded()
            self.result["watch_cpu_pct"] = ((b.cpu - a.cpu) / (wb - wa) * 1000).rounded() / 10
            self.result["rss_mb_end"] = b.rssMB.rounded()
            self.result["rss_mb_peak"] = max(peak, b.rssMB).rounded()
            self.write()
        }
    }

    func write() {
        func pct(_ a: [Double], _ p: Double) -> Double {
            let s = a.sorted()
            guard !s.isEmpty else { return .nan }
            return s[min(s.count - 1, Int((Double(s.count - 1) * p).rounded()))]
        }
        let t = view.getTerminal()
        result["client"] = "native"
        result["visible"] = view.window?.occlusionState.contains(.visible) ?? false
        result["key_window"] = view.window?.isKeyWindow ?? false
        result["cols"] = t.cols
        result["rows"] = t.rows
        result["n"] = paintMs.count
        result["socket_p50_ms"] = pct(socketMs, 0.5)
        result["socket_p95_ms"] = pct(socketMs, 0.95)
        result["paint_p50_ms"] = pct(paintMs, 0.5)
        result["paint_p95_ms"] = pct(paintMs, 0.95)
        result["paint_max_ms"] = paintMs.max() ?? .nan
        result["stages_p50_ms"] = stages.mapValues { (pct($0, 0.5) * 10).rounded() / 10 }
        result["stages_p95_ms"] = stages.mapValues { (pct($0, 0.95) * 10).rounded() / 10 }
        result["paint_ms"] = paintMs.map { ($0 * 10).rounded() / 10 }
        if let data = try? JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: URL(fileURLWithPath: out))
        }
        if CommandLine.arguments.contains("--bench-quit") { NSApp.terminate(nil) }
    }

    /// When this process started, on the systemUptime clock.
    static func processStartUptime() -> TimeInterval? {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
        guard sysctl(&mib, 4, &info, &size, nil, 0) == 0 else { return nil }
        let tv = info.kp_proc.p_un.__p_starttime
        let startWall = Double(tv.tv_sec) + Double(tv.tv_usec) / 1e6
        let ageNow = Date().timeIntervalSince1970 - startWall
        return ProcessInfo.processInfo.systemUptime - ageNow
    }
}
