//! Finding the daemon: the data directory, `runtime.json`, and a loopback
//! probe of `/healthz` and `/v1/status` (contracts: .ai/03-contracts.md
//! § Runtime file). No HTTP client crate: every request is a single GET or
//! POST to 127.0.0.1, so a few lines over `TcpStream` are enough.

use serde::Deserialize;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

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

/// Whether a daemon is upgrading this data directory's database: it rewrites
/// `upgrading.json` every two seconds while it does, and answers only once it
/// is done. A file older than `UPGRADING_STALE` was left by one that died.
pub fn upgrading(dir: &Path) -> bool {
    std::fs::metadata(dir.join("upgrading.json"))
        .and_then(|m| m.modified())
        .is_ok_and(|t| t.elapsed().is_ok_and(|age| age < UPGRADING_STALE))
}

const UPGRADING_STALE: Duration = Duration::from_secs(10);

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

/// Follows a daemon already found, for the monitor's poll. A daemon found
/// running stays running through a hiccup: one failed probe, or a run of
/// them shorter than the grace, keeps the window on the dashboard. What ends
/// it at once is proof the daemon has stopped: `runtime.json` gone, naming
/// another daemon, or (on Unix) its pid no longer alive.
///
/// Why: on the owner's Mac (2026-10-28, load ~15) the window flipped to
/// "the daemon is gone" and back dozens of times a day while the same
/// daemon ran for 15 h. Every non-timeout error read as a stop on the first
/// probe, and the full check every `FULL_CHECK` asked `/v1/status`, which
/// runs database queries that were taking seconds, with no grace at all.
/// Each transition to absent is now logged with its reason, so the next
/// report can be answered from `app.log`.
pub struct Watch {
    error_grace: Duration,
    slow_grace: Duration,
    failing: Option<Failing>,
    /// Failure runs that ended in an answer, since the last summary line.
    hiccups: u32,
    last_hiccup: String,
    summary_at: Option<Instant>,
}

/// A run of failed probes of a daemon still counted as running.
struct Failing {
    since: Instant,
    count: u32,
    timeouts_only: bool,
    first: String,
    last: String,
}

/// How long a daemon that refuses, resets or answers garbage still counts
/// as there.
pub const ERROR_GRACE: Duration = Duration::from_secs(5);
/// How long a daemon that accepts but answers slowly still counts as there.
pub const SLOW_GRACE: Duration = Duration::from_secs(20);
/// Brief failures that recovered are summed into one log line at most this
/// often, so the log stays a few lines a day.
pub const HICCUP_SUMMARY_EVERY: Duration = Duration::from_secs(600);

impl Default for Watch {
    fn default() -> Self {
        Self::with_graces(ERROR_GRACE, SLOW_GRACE)
    }
}

impl Watch {
    pub fn with_graces(error_grace: Duration, slow_grace: Duration) -> Self {
        Watch {
            error_grace,
            slow_grace,
            failing: None,
            hiccups: 0,
            last_hiccup: String::new(),
            summary_at: None,
        }
    }

    /// One poll. `full` also asks `/v1/status` (a fresh status); otherwise
    /// `/healthz` alone, and the last status is kept. Without a daemon found
    /// before, it is `find`.
    pub fn check(&mut self, dir: &Path, last: &Found, full: bool) -> Found {
        let Found::Running { rt: was, status } = last else {
            self.failing = None;
            return find(dir);
        };
        let rt = match read_runtime(dir) {
            None => return self.gone(dir, "runtime.json is gone or unreadable".into()),
            Some(rt) if rt != *was => {
                // Another daemon: find it afresh, with no grace for the old one.
                self.failing = None;
                let found = find(dir);
                if found == Found::Absent {
                    self.log_gone(
                        dir,
                        &format!(
                            "runtime.json now names port {} pid {} (was port {} pid {}), which does not answer",
                            rt.port, rt.pid, was.port, was.pid
                        ),
                    );
                }
                return found;
            }
            Some(rt) => rt,
        };
        if rt.pid != 0 && pid_alive(rt.pid) == Some(false) {
            return self.gone(dir, format!("its process (pid {}) has exited", rt.pid));
        }
        let probe = match request(rt.port, "GET", "/healthz", None) {
            Ok((200, _)) => Ok(()),
            Ok((code, _)) => Err((false, format!("/healthz answered HTTP {code}"))),
            Err(e) => Err((is_timeout(&e), format!("/healthz: {}", describe(&e)))),
        };
        if let Err((timeout, why)) = probe {
            return self.failed(dir, rt, status, timeout, why);
        }
        self.recovered(dir);
        let mut status = status.clone();
        if full {
            // /healthz answered: the daemon is there. /v1/status runs
            // database queries and may be slow when /healthz is not; a
            // failure here keeps the status already known.
            match fetch_status(rt.port) {
                Ok(s) => status = s,
                Err(why) => self.hiccup(dir, format!("/v1/status: {why}")),
            }
        }
        Found::Running { rt, status }
    }

    fn failed(
        &mut self,
        dir: &Path,
        rt: Runtime,
        status: &Status,
        timeout: bool,
        why: String,
    ) -> Found {
        let f = self.failing.get_or_insert_with(|| Failing {
            since: Instant::now(),
            count: 0,
            timeouts_only: true,
            first: why.clone(),
            last: String::new(),
        });
        f.count += 1;
        f.timeouts_only &= timeout;
        f.last = why;
        let grace = if f.timeouts_only {
            self.slow_grace
        } else {
            self.error_grace
        };
        let for_ = f.since.elapsed();
        if for_ < grace {
            return Found::Running {
                rt,
                status: status.clone(),
            };
        }
        let msg = format!(
            "{} failed checks over {:.1} s (grace {} s); first: {}; last: {}",
            f.count,
            for_.as_secs_f64(),
            grace.as_secs(),
            f.first,
            f.last
        );
        self.failing = None;
        self.log_gone(dir, &msg);
        Found::Absent
    }

    /// A run of failures ended with an answer: counted, not logged at once.
    fn recovered(&mut self, dir: &Path) {
        if let Some(f) = self.failing.take() {
            let why = format!(
                "{} failed checks over {:.1} s, first: {}",
                f.count,
                f.since.elapsed().as_secs_f64(),
                f.first
            );
            self.hiccup(dir, why);
        }
    }

    /// A failure the daemon recovered from. The first is logged at once;
    /// later ones are counted into one line per `HICCUP_SUMMARY_EVERY`.
    fn hiccup(&mut self, dir: &Path, why: String) {
        self.hiccups += 1;
        self.last_hiccup = why;
        if self
            .summary_at
            .is_some_and(|t| t.elapsed() < HICCUP_SUMMARY_EVERY)
        {
            return;
        }
        crate::applog::line(
            dir,
            &format!(
                "daemon: {} brief failure(s) since the last such line, the dashboard kept; last: {}",
                self.hiccups, self.last_hiccup
            ),
        );
        self.hiccups = 0;
        self.summary_at = Some(Instant::now());
    }

    fn gone(&mut self, dir: &Path, why: String) -> Found {
        self.failing = None;
        self.log_gone(dir, &why);
        Found::Absent
    }

    fn log_gone(&self, dir: &Path, why: &str) {
        crate::applog::line(dir, &format!("daemon: counted as gone: {why}"));
    }
}

fn is_timeout(e: &std::io::Error) -> bool {
    matches!(
        e.kind(),
        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
    )
}

/// An error for the log: its kind and its message.
fn describe(e: &std::io::Error) -> String {
    format!("{:?}: {e}", e.kind())
}

/// `/v1/status` alone, with why it failed.
fn fetch_status(port: u16) -> Result<Status, String> {
    match request(port, "GET", "/v1/status", None) {
        Ok((200, body)) => serde_json::from_str(&body).map_err(|e| format!("unreadable: {e}")),
        Ok((code, _)) => Err(format!("HTTP {code}")),
        Err(e) => Err(describe(&e)),
    }
}

/// Whether a process is alive: `Some(false)` only when the OS says there is
/// no such process. `None` where this is not asked (Windows), and the
/// error grace alone decides.
pub fn pid_alive(pid: u32) -> Option<bool> {
    #[cfg(unix)]
    {
        let Ok(p) = i32::try_from(pid) else {
            return None;
        };
        // SAFETY: signal 0 checks only that the process exists and may be
        // signalled; nothing is delivered.
        if unsafe { libc::kill(p, 0) } == 0 {
            return Some(true);
        }
        // EPERM: it exists and belongs to someone else.
        Some(std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH))
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        None
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
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
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
    // A connect that fails is never "slow": on Windows a closed loopback
    // port does not refuse, it times out, so the kind is changed here and
    // only a read or write past the timeout reads as a busy daemon.
    let mut s = TcpStream::connect_timeout(&addr, timeout)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::NotConnected, e))?;
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
    fn an_upgrade_is_seen_while_its_file_is_fresh() {
        let dir = temp_dir("upgrading");
        assert!(!upgrading(&dir));
        let f = dir.join("upgrading.json");
        std::fs::write(&f, r#"{"pid":1}"#).unwrap();
        assert!(upgrading(&dir));
        let old = std::time::SystemTime::now() - UPGRADING_STALE;
        std::fs::File::options()
            .write(true)
            .open(&f)
            .unwrap()
            .set_modified(old)
            .unwrap();
        assert!(!upgrading(&dir));
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

    fn running(dir: &Path) -> Found {
        Found::Running {
            rt: read_runtime(dir).unwrap(),
            status: Status {
                version: "v1".into(),
                api_level: 3,
            },
        }
    }

    /// A port nothing listens on.
    fn closed_port() -> u16 {
        TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }

    fn short() -> Watch {
        Watch::with_graces(Duration::from_millis(1500), Duration::from_secs(20))
    }

    #[test]
    fn a_recheck_asks_only_healthz_and_keeps_the_last_status() {
        // No /v1/status here: a recheck that asked for it would read absent.
        let port = serve(vec![("/healthz", r#"{"status":"ok"}"#)]);
        let dir = temp_dir("recheck");
        write_runtime(&dir, port, r#","api_level":3"#);
        let last = running(&dir);
        let mut w = Watch::default();
        assert_eq!(w.check(&dir, &last, false), last);
        // A different daemon in runtime.json: a full find (here, absent).
        write_runtime(&dir, port, r#","api_level":4"#);
        assert_eq!(w.check(&dir, &last, false), Found::Absent);
        assert_eq!(
            w.check(&temp_dir("recheck-none"), &Found::Absent, false),
            Found::Absent
        );
    }

    #[test]
    fn a_full_check_keeps_the_status_when_only_v1_status_fails() {
        // /healthz answers, /v1/status is a 404: the daemon is there.
        let port = serve(vec![("/healthz", r#"{"status":"ok"}"#)]);
        let dir = temp_dir("full-status-fails");
        write_runtime(&dir, port, r#","api_level":3"#);
        let last = running(&dir);
        assert_eq!(Watch::default().check(&dir, &last, true), last);
        let log = std::fs::read_to_string(dir.join(crate::applog::FILE)).unwrap();
        assert!(log.contains("/v1/status: HTTP 404"), "{log}");
    }

    #[test]
    fn a_full_check_takes_the_fresh_status() {
        let port = serve(vec![
            ("/healthz", r#"{"status":"ok"}"#),
            ("/v1/status", r#"{"version":"v2","api_level":3}"#),
        ]);
        let dir = temp_dir("full-status");
        write_runtime(&dir, port, r#","api_level":3"#);
        let Found::Running { status, .. } = Watch::default().check(&dir, &running(&dir), true)
        else {
            panic!("expected running");
        };
        assert_eq!(status.version, "v2");
    }

    #[test]
    fn a_slow_daemon_is_kept() {
        // Accepts and never answers: a daemon too busy for the timeout.
        let ln = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = ln.local_addr().unwrap().port();
        thread::spawn(move || {
            let held: Vec<_> = ln.incoming().take(4).collect();
            thread::sleep(Duration::from_secs(10));
            drop(held);
        });
        let dir = temp_dir("slow");
        write_runtime(&dir, port, r#","api_level":3"#);
        let last = running(&dir);
        // Past the error grace, inside the slow one: timeouts only.
        let mut w = Watch::with_graces(Duration::ZERO, Duration::from_secs(20));
        assert_eq!(w.check(&dir, &last, false), last, "a timeout is not a stop");
        assert_eq!(w.check(&dir, &last, false), last);
    }

    #[test]
    fn a_brief_refusal_is_kept_and_a_lasting_one_is_gone() {
        let port = closed_port();
        let dir = temp_dir("refused");
        write_runtime(&dir, port, r#","api_level":3"#);
        let last = running(&dir);
        let mut w = short();
        // Nothing listens: within the grace the daemon is still there.
        assert_eq!(w.check(&dir, &last, false), last);
        // The listener comes back within the grace: one answer resets it.
        let ln = TcpListener::bind(("127.0.0.1", port)).unwrap();
        let back = thread::spawn(move || {
            let (mut c, _) = ln.accept().unwrap();
            let mut buf = [0u8; 512];
            let mut req = String::new();
            while !req.contains("\r\n\r\n") {
                match c.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => req.push_str(&String::from_utf8_lossy(&buf[..n])),
                }
            }
            let _ = c.write_all(b"HTTP/1.1 200 OK\r\n\r\n{}");
        });
        assert_eq!(w.check(&dir, &last, false), last);
        back.join().unwrap();
        // Closed again, and kept closed past the grace: gone, and logged.
        assert_eq!(w.check(&dir, &last, false), last);
        thread::sleep(Duration::from_millis(1600));
        assert_eq!(w.check(&dir, &last, false), Found::Absent);
        let log = std::fs::read_to_string(dir.join(crate::applog::FILE)).unwrap();
        assert!(log.contains("daemon: counted as gone"), "{log}");
        assert!(log.contains("/healthz: NotConnected"), "{log}");
    }

    #[test]
    fn a_reset_or_short_answer_is_kept_within_the_grace() {
        // Accepts, reads the request, answers garbage or nothing, closes.
        let ln = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = ln.local_addr().unwrap().port();
        thread::spawn(move || {
            for (i, conn) in ln.incoming().take(6).enumerate() {
                let mut c = conn.unwrap();
                let mut buf = [0u8; 512];
                let _ = c.read(&mut buf);
                if i % 2 == 0 {
                    let _ = c.write_all(b"HTTP/1.1 2");
                }
            }
        });
        let dir = temp_dir("short-read");
        write_runtime(&dir, port, r#","api_level":3"#);
        let last = running(&dir);
        let mut w = short();
        assert_eq!(w.check(&dir, &last, false), last);
        assert_eq!(w.check(&dir, &last, false), last);
        thread::sleep(Duration::from_millis(1600));
        assert_eq!(w.check(&dir, &last, false), Found::Absent);
        let log = std::fs::read_to_string(dir.join(crate::applog::FILE)).unwrap();
        assert!(log.contains("daemon: counted as gone"), "{log}");
        assert!(log.contains("first: /healthz: "), "{log}");
    }

    #[test]
    fn a_removed_runtime_file_is_gone_at_once() {
        let port = serve(vec![("/healthz", r#"{"status":"ok"}"#)]);
        let dir = temp_dir("removed");
        write_runtime(&dir, port, r#","api_level":3"#);
        let last = running(&dir);
        let mut w = Watch::default();
        assert_eq!(w.check(&dir, &last, false), last);
        std::fs::remove_file(dir.join("runtime.json")).unwrap();
        assert_eq!(w.check(&dir, &last, false), Found::Absent);
        let log = std::fs::read_to_string(dir.join(crate::applog::FILE)).unwrap();
        assert!(log.contains("runtime.json is gone"), "{log}");
    }

    #[cfg(unix)]
    #[test]
    fn an_exited_pid_is_gone_at_once() {
        let mut child = std::process::Command::new("true").spawn().unwrap();
        let pid = child.id();
        child.wait().unwrap();
        assert_eq!(pid_alive(pid), Some(false));
        assert_eq!(pid_alive(std::process::id()), Some(true));
        // The port still answers (a stranger on it): the pid decides.
        let port = serve(vec![("/healthz", r#"{"status":"ok"}"#)]);
        let dir = temp_dir("exited");
        std::fs::write(
            dir.join("runtime.json"),
            format!(r#"{{"port":{port},"pid":{pid},"api_level":3}}"#),
        )
        .unwrap();
        let last = running(&dir);
        assert_eq!(Watch::default().check(&dir, &last, false), Found::Absent);
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
