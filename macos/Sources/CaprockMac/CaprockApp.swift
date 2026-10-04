import AppKit
import SwiftUI
import WebKit

// Caprock for macOS — SPIKE. Talks to an already-running daemon; never starts one.
//
//   Caprock.app --args [--data-dir DIR] [--bench-session ID --bench-out FILE [--bench-keys N] [--bench-quit]]

enum Item: Hashable {
    case dashboard
    case session(String)
}

struct WebView: NSViewRepresentable {
    let url: URL
    func makeNSView(context: Context) -> WKWebView {
        let w = WKWebView()
        w.load(URLRequest(url: url))
        return w
    }
    func updateNSView(_ v: WKWebView, context: Context) {}
}

struct SessionLine: View {
    let s: SessionRow
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(s.project.isEmpty ? (s.cwd as NSString).lastPathComponent : s.project).fontWeight(.medium)
                Spacer()
                Text(String(format: "$%.2f", s.stats.cost_usd)).monospacedDigit().foregroundStyle(.secondary)
            }
            HStack(spacing: 6) {
                Text(s.agent ?? "claude")
                Text("·")
                Text(s.activity.health).foregroundStyle(s.activity.health == "waiting-on-you" ? .orange : .secondary)
                if !s.attachable { Text("· observe-only") }
            }
            .font(.caption).foregroundStyle(.secondary)
        }
    }
}

struct ContentView: View {
    @EnvironmentObject var daemon: Daemon
    @State private var selection: Item? = Args.value("--bench-session").map { .session($0) } ?? .dashboard

    var body: some View {
        NavigationSplitView {
            List(selection: $selection) {
                Label("Dashboard", systemImage: "gauge").tag(Item.dashboard)
                Section("Live sessions") {
                    ForEach(daemon.sessions) { s in SessionLine(s: s).tag(Item.session(s.session_id)) }
                }
            }
            .navigationSplitViewColumnWidth(min: 220, ideal: 260)
        } detail: {
            detail
        }
        .task {
            while !Task.isCancelled {
                await daemon.refresh()
                try? await Task.sleep(nanoseconds: 2_000_000_000)
            }
        }
    }

    @ViewBuilder var detail: some View {
        if let err = daemon.error, daemon.runtime == nil {
            Text(err).padding()
        } else if let base = daemon.base, let rt = daemon.runtime {
            switch selection {
            case .session(let id):
                if let s = daemon.sessions.first(where: { $0.session_id == id }) {
                    if s.attachable {
                        TerminalPane(session: s, base: base, token: rt.token).id(id)
                    } else {
                        Text("Caprock did not start this session, so it has no terminal here.").padding()
                    }
                } else {
                    ProgressView()
                }
            default:
                WebView(url: base)
            }
        } else {
            ProgressView()
        }
    }
}

@main
struct CaprockApp: App {
    @StateObject private var daemon = Daemon()

    init() {
        // A SwiftPM executable is not a bundled app until bundle.sh wraps it;
        // either way it should take the Dock and the keyboard.
        NSApplication.shared.setActivationPolicy(.regular)
        DispatchQueue.main.async { NSApp.activate(ignoringOtherApps: true) }
    }

    var body: some Scene {
        WindowGroup("Caprock") {
            ContentView().environmentObject(daemon).frame(minWidth: 900, minHeight: 560)
        }
        MenuBarExtra {
            Text(daemon.fiveHourPct.map { String(format: "5-hour limit: %.0f%% used", $0) } ?? "5-hour limit: no data yet")
            Text("\(daemon.waiting) waiting on you · \(daemon.sessions.count) live")
            Divider()
            Button("Quit Caprock") { NSApp.terminate(nil) }
        } label: {
            Text(menuTitle)
        }
    }

    var menuTitle: String {
        var t = daemon.fiveHourPct.map { String(format: "◆ %.0f%%", $0) } ?? "◆"
        if daemon.waiting > 0 { t += " · \(daemon.waiting) waiting" }
        return t
    }
}
