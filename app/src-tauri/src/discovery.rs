//! Finding the daemon: the data directory, `runtime.json`, and a loopback
//! probe of `/healthz` and `/v1/status` (contracts: .ai/03-contracts.md
//! § Runtime file). No HTTP client crate: every request is a single GET or
//! POST to 127.0.0.1, so a few lines over `TcpStream` are enough.

use serde::Deserialize;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// The lowest daemon API level this app works with (`api_level` in
/// `/v1/status`). A daemon below it is shown as needing an upgrade.
pub const MIN_API_LEVEL: u32 = 1;

/// Same override the daemon honours (`config.EnvDataDir`).
const ENV_DATA_DIR: &str = "CAPROCK_DATA_DIR";

/// `<data_dir>/runtime.json`, written by the daemon on start.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct Runtime {
    pub port: u16,
    #[serde(default)]
    pub token: String,
    #[serde(default)]
    pub pid: u32,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub api_level: u32,
    #[serde(default)]
    pub exe: String,
}

/// What `/v1/status` says about the daemon, the fields this app reads.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct Status {
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub api_level: u32,
}

/// The daemon as found right now.
#[derive(Debug, Clone, PartialEq)]
pub enum Found {
    /// Nothing answers for this data directory.
    Absent,
    /// A daemon answers; `status` is its `/v1/status`.
    Running { rt: Runtime, status: Status },
}

/// Resolves the data directory exactly as the daemon does
/// (`config.DataDir`): `$CAPROCK_DATA_DIR`, else `<user config dir>/caprock`.
pub fn data_dir() -> Option<PathBuf> {
    if let Some(v) = std::env::var_os(ENV_DATA_DIR).filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(v));
    }
    dirs::config_dir().map(|d| d.join("caprock"))
}

pub fn read_runtime(dir: &Path) -> Option<Runtime> {
    let raw = std::fs::read(dir.join("runtime.json")).ok()?;
    serde_json::from_slice(&raw).ok()
}

/// Reads `runtime.json` and asks the daemon it names whether it is alive. A
/// stale file (a crashed daemon) reads as absent.
pub fn find(dir: &Path) -> Found {
    let Some(rt) = read_runtime(dir) else {
        return Found::Absent;
    };
    match status(rt.port) {
        Some(status) => Found::Running { rt, status },
        None => Found::Absent,
    }
}

/// `find` for a daemon already found (`last`): while `runtime.json` names the
/// same daemon, `/healthz` alone says it is still there and the last
/// `/v1/status` is kept. One request instead of two, twice a second, is most
/// of what an idle window costs the shell (WP-16). Anything else is `find`.
pub fn recheck(dir: &Path, last: &Found) -> Found {
    let Found::Running { rt: was, status } = last else {
        return find(dir);
    };
    match read_runtime(dir) {
        Some(rt) if rt == *was => match request(rt.port, "GET", "/healthz", None) {
            Ok((200, _)) => Found::Running {
                rt,
                status: status.clone(),
            },
            _ => Found::Absent,
        },
        _ => find(dir),
    }
}

/// `/healthz` then `/v1/status`; `None` when either fails.
pub fn status(port: u16) -> Option<Status> {
    let (code, _) = request(port, "GET", "/healthz", None).ok()?;
    if code != 200 {
        return None;
    }
    let (code, body) = request(port, "GET", "/v1/status", None).ok()?;
    if code != 200 {
        return None;
    }
    serde_json::from_str(&body).ok()
}

/// Whether a running daemon is the one this app installed into
/// `<data_dir>/bin`, and so one it may replace.
pub fn is_ours(rt: &Runtime, bin: &Path) -> bool {
    if rt.exe.is_empty() {
        return false;
    }
    let canon = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    canon(Path::new(&rt.exe)) == canon(bin)
}

/// The executable of a process, for a daemon too old to write `exe` into
/// `runtime.json`. Empty when the OS will not say.
pub fn exe_of_pid(pid: u32) -> String {
    if pid == 0 {
        return String::new();
    }
    #[cfg(target_os = "linux")]
    return std::fs::read_link(format!("/proc/{pid}/exe"))
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    #[cfg(target_os = "macos")]
    return std::process::Command::new("/bin/ps")
        .args(["-o", "comm=", "-p", &pid.to_string()])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    String::new()
}

/// The upgrade command for a daemon binary at `exe`, inferred from its path
/// the same way the daemon does (`internal/update.commandForPath`).
pub fn command_for_path(exe: &str) -> &'static str {
    let p = exe.replace('\\', "/");
    let lower = p.to_lowercase();
    if p.contains("/Cellar/") || p.contains("/homebrew/") || p.contains("/linuxbrew/") {
        "brew update && brew upgrade caprock"
    } else if lower.contains("/scoop/apps/") {
        "scoop update caprock"
    } else if p.ends_with("/go/bin/caprock") || lower.ends_with("/go/bin/caprock.exe") {
        "go install github.com/dspv/caprock/cmd/caprock@latest"
    } else {
        ""
    }
}

/// One HTTP/1.0 request to the daemon on loopback, with a short timeout. The
/// body is read to EOF (HTTP/1.0 closes the connection).
pub fn request(
    port: u16,
    method: &str,
    path: &str,
    bearer: Option<&str>,
) -> std::io::Result<(u16, String)> {
    send(port, method, path, bearer, "")
}

/// A POST with a JSON body: the daemon requires `application/json` on a
/// state-changing request from a client that is not a browser.
pub fn post_json(port: u16, path: &str, json: &str) -> std::io::Result<(u16, String)> {
    send(port, "POST", path, None, json)
}

fn send(
    port: u16,
    method: &str,
    path: &str,
    bearer: Option<&str>,
    json: &str,
) -> std::io::Result<(u16, String)> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let timeout = Duration::from_millis(800);
    let mut s = TcpStream::connect_timeout(&addr, timeout)?;
    s.set_read_timeout(Some(timeout))?;
    s.set_write_timeout(Some(timeout))?;
    let auth = bearer
        .map(|t| format!("Authorization: Bearer {t}\r\n"))
        .unwrap_or_default();
    let kind = if json.is_empty() {
        ""
    } else {
        "Content-Type: application/json\r\n"
    };
    write!(
        s,
        "{method} {path} HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\n{auth}{kind}Content-Length: {}\r\nConnection: close\r\n\r\n{json}",
        json.len()
    )?;
    let mut raw = Vec::new();
    s.take(4 << 20).read_to_end(&mut raw)?;
    parse_response(&raw).ok_or_else(|| std::io::Error::other("malformed HTTP response"))
}

fn parse_response(raw: &[u8]) -> Option<(u16, String)> {
    let text = String::from_utf8_lossy(raw);
    let (head, body) = text.split_once("\r\n\r\n")?;
    let code = head.split_whitespace().nth(1)?.parse().ok()?;
    Some((code, body.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::thread;

    /// A loopback server answering every request with `body` as JSON.
    fn serve(responses: Vec<(&'static str, &'static str)>) -> u16 {
        let ln = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = ln.local_addr().unwrap().port();
        thread::spawn(move || {
            for conn in ln.incoming().take(8) {
                let mut c = conn.unwrap();
                // Read the whole request: closing with unread bytes resets the
                // connection under the client's read.
                let mut req = String::new();
                let mut buf = [0u8; 512];
                while !req.contains("\r\n\r\n") {
                    match c.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => req.push_str(&String::from_utf8_lossy(&buf[..n])),
                    }
                }
                let body = responses
                    .iter()
                    .find(|(p, _)| req.starts_with(&format!("GET {p} ")))
                    .map(|(_, b)| *b);
                let reply = match body {
                    Some(b) => {
                        format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{b}")
                    }
                    None => "HTTP/1.1 404 Not Found\r\n\r\n".to_string(),
                };
                let _ = c.write_all(reply.as_bytes());
            }
        });
        port
    }

    fn write_runtime(dir: &Path, port: u16, extra: &str) {
        std::fs::write(
            dir.join("runtime.json"),
            format!(r#"{{"port":{port},"token":"t","pid":1{extra}}}"#),
        )
        .unwrap();
    }

    fn temp_dir(name: &str) -> PathBuf {
        let d =
            std::env::temp_dir().join(format!("caprock-app-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn a_live_daemon_is_found_with_its_api_level() {
        let port = serve(vec![
            ("/healthz", r#"{"status":"ok","version":"v1"}"#),
            ("/v1/status", r#"{"version":"v1","api_level":3,"pid":1}"#),
        ]);
        let dir = temp_dir("live");
        write_runtime(&dir, port, r#","api_level":3,"exe":"/x/caprock""#);
        match find(&dir) {
            Found::Running { rt, status } => {
                assert_eq!(rt.port, port);
                assert_eq!(rt.exe, "/x/caprock");
                assert_eq!(status.api_level, 3);
            }
            other => panic!("expected running, got {other:?}"),
        }
    }

    #[test]
    fn a_daemon_from_before_api_level_reads_as_level_zero() {
        let port = serve(vec![
            ("/healthz", r#"{"status":"ok"}"#),
            ("/v1/status", r#"{"version":"v0.74.0"}"#),
        ]);
        let dir = temp_dir("old");
        write_runtime(&dir, port, "");
        let Found::Running { status, .. } = find(&dir) else {
            panic!("expected running");
        };
        assert_eq!(status.api_level, 0);
        assert!(status.api_level < MIN_API_LEVEL);
    }

    #[test]
    fn a_stale_runtime_file_reads_as_absent() {
        // Bind and drop: nothing listens on this port any more.
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let dir = temp_dir("stale");
        write_runtime(&dir, port, "");
        assert_eq!(find(&dir), Found::Absent);
        assert_eq!(find(&temp_dir("none")), Found::Absent);
    }

    #[test]
    fn a_recheck_asks_only_healthz_and_keeps_the_last_status() {
        // No /v1/status here: a recheck that asked for it would read absent.
        let port = serve(vec![("/healthz", r#"{"status":"ok"}"#)]);
        let dir = temp_dir("recheck");
        write_runtime(&dir, port, r#","api_level":3"#);
        let rt = read_runtime(&dir).unwrap();
        let status = Status {
            version: "v1".into(),
            api_level: 3,
        };
        let last = Found::Running { rt, status };
        assert_eq!(recheck(&dir, &last), last);
        // A different daemon in runtime.json: a full find (here, absent).
        write_runtime(&dir, port, r#","api_level":4"#);
        assert_eq!(recheck(&dir, &last), Found::Absent);
        assert_eq!(
            recheck(&temp_dir("recheck-none"), &Found::Absent),
            Found::Absent
        );
    }

    #[test]
    fn ours_means_the_binary_in_our_bin_dir() {
        let dir = temp_dir("ours");
        let bin = dir.join("caprock");
        std::fs::write(&bin, b"x").unwrap();
        let mut rt = Runtime {
            port: 1,
            token: String::new(),
            pid: 1,
            version: String::new(),
            api_level: 1,
            exe: bin.to_string_lossy().into_owned(),
        };
        assert!(is_ours(&rt, &bin));
        rt.exe = "/opt/homebrew/bin/caprock".into();
        assert!(!is_ours(&rt, &bin));
        rt.exe = String::new();
        assert!(!is_ours(&rt, &bin));
    }

    #[test]
    fn names_the_upgrade_command_by_install_path() {
        let brew = "brew update && brew upgrade caprock";
        assert_eq!(command_for_path("/opt/homebrew/bin/caprock"), brew);
        assert_eq!(
            command_for_path("/usr/local/Cellar/caprock/0.74.0/bin/caprock"),
            brew
        );
        assert_eq!(
            command_for_path(r"C:\Users\a\scoop\apps\caprock\1.0\caprock.exe"),
            "scoop update caprock"
        );
        assert!(command_for_path("/Users/a/go/bin/caprock").starts_with("go install"));
        assert_eq!(
            command_for_path("/Users/a/Library/Application Support/caprock/bin/caprock"),
            ""
        );
        assert_eq!(command_for_path(""), "");
    }

    #[cfg(unix)]
    #[test]
    fn finds_the_executable_of_a_live_process() {
        let me = exe_of_pid(std::process::id());
        assert!(me.contains("caprock_app"), "{me}");
        assert_eq!(exe_of_pid(0), "");
    }

    #[test]
    fn parses_a_response() {
        let raw = b"HTTP/1.1 503 Service Unavailable\r\nX: y\r\n\r\n{\"a\":1}";
        assert_eq!(parse_response(raw), Some((503, "{\"a\":1}".into())));
        assert_eq!(parse_response(b"garbage"), None);
    }
}
