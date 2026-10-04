import Foundation

/// Where the daemon is, and the few reads the app needs from it.
///
/// The app never starts a daemon (spike rule): it reads `<data_dir>/runtime.json`
/// the way the CLI does — `--data-dir`, else `$CAPROCK_DATA_DIR`, else
/// `~/Library/Application Support/caprock` — and talks to that port.
struct Runtime: Decodable {
    let port: Int
    let token: String
}

struct RateWindow: Decodable { let used_percentage: Double? }
struct RateLimits: Decodable { let five_hour: RateWindow? }
struct Summary: Decodable { let rate_limits: RateLimits? }

struct SessionStats: Decodable { let cost_usd: Double }
struct SessionActivity: Decodable { let health: String; let phrase: String? }
struct SessionRow: Decodable, Identifiable, Hashable {
    let session_id: String
    let project: String
    let cwd: String
    let status: String
    let owned: Bool
    let agent: String?
    let detached: Bool?
    let stats: SessionStats
    let activity: SessionActivity
    var id: String { session_id }
    static func == (a: SessionRow, b: SessionRow) -> Bool { a.session_id == b.session_id }
    func hash(into h: inout Hasher) { h.combine(session_id) }
    /// The web Terminal attaches only to a live session Caprock started in this run.
    var attachable: Bool { owned && status != "ended" && !(detached ?? false) }
}

enum Args {
    static func value(_ name: String) -> String? {
        let a = CommandLine.arguments
        guard let i = a.firstIndex(of: name), i + 1 < a.count else { return nil }
        return a[i + 1]
    }
}

@MainActor
final class Daemon: ObservableObject {
    @Published var runtime: Runtime?
    @Published var sessions: [SessionRow] = []
    @Published var fiveHourPct: Double?
    @Published var error: String?

    let dataDir: URL

    init() {
        if let d = Args.value("--data-dir") {
            dataDir = URL(fileURLWithPath: d)
        } else if let d = ProcessInfo.processInfo.environment["CAPROCK_DATA_DIR"], !d.isEmpty {
            dataDir = URL(fileURLWithPath: d)
        } else {
            dataDir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("caprock")
        }
        loadRuntime()
    }

    var base: URL? { runtime.map { URL(string: "http://127.0.0.1:\($0.port)")! } }

    func loadRuntime() {
        let url = dataDir.appendingPathComponent("runtime.json")
        do {
            runtime = try JSONDecoder().decode(Runtime.self, from: Data(contentsOf: url))
            error = nil
        } catch {
            runtime = nil
            self.error = "No running daemon: \(url.path) is unreadable. Start it with `caprock up`."
        }
    }

    func get<T: Decodable>(_ path: String, as: T.Type) async throws -> T {
        guard let base else { throw URLError(.cannotConnectToHost) }
        let (data, _) = try await URLSession.shared.data(from: base.appendingPathComponent(path))
        return try JSONDecoder().decode(T.self, from: data)
    }

    func refresh() async {
        if runtime == nil { loadRuntime() }
        guard let base else { return }
        do {
            var c = URLComponents(url: base.appendingPathComponent("/v1/sessions"), resolvingAgainstBaseURL: false)!
            c.queryItems = [URLQueryItem(name: "active", value: "true")]
            let (data, _) = try await URLSession.shared.data(from: c.url!)
            sessions = try JSONDecoder().decode([SessionRow].self, from: data)
            error = nil
        } catch {
            // The daemon may have restarted on a new port; re-read runtime.json next time.
            self.error = "Cannot reach the daemon: \(error.localizedDescription)"
            loadRuntime()
        }
        if let s = try? await get("/v1/stats/summary", as: Summary.self) {
            fiveHourPct = s.rate_limits?.five_hour?.used_percentage
        }
    }

    var waiting: Int { sessions.filter { $0.activity.health == "waiting-on-you" }.count }
}
