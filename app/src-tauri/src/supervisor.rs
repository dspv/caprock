//! The daemon supervisor (WP-02): use a running daemon, else start the bundled
//! one, and follow it through restarts. Rules it keeps (.ai/21-app.md
//! § Architecture):
//!
//! - One daemon per data directory. A running daemon always wins, whoever
//!   installed it (Homebrew, Scoop, `go install`, this app); the configured
//!   port's bind is the lock that stops a second one.
//! - Never stop a daemon it did not start. Quitting the app leaves the daemon
//!   and every session running.
//! - Only a Homebrew `caprock` or the bundled one (from `<data_dir>/bin`)
//!   runs, with fixed arguments: `service install`, `service uninstall`, `up`.
//! - macOS only (ADR-040): the app's own daemon is the one that runs. It
//!   starts its bundled copy, never the formula's, and moves a running
//!   Homebrew daemon onto that copy once when its own is not older — a
//!   formula's binary lives at a new Cellar path every release, and every
//!   new path is one more "caprock" in Privacy & Security.

use crate::discovery::{self, Found, Runtime, MIN_API_LEVEL};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// How long a daemon must be gone before the app says so. With a 500 ms
/// poll, a stop is shown in under 2 s (WP-02).
pub const STOPPED_AFTER: Duration = Duration::from_millis(1200);

const EXE: &str = if cfg!(windows) {
    "caprock.exe"
} else {
    "caprock"
};

/// Where Homebrew links the `caprock` formula's binary, by prefix.
const BREW_BINS: &[&str] = &[
    "/opt/homebrew/bin/caprock",
    "/usr/local/bin/caprock",
    "/home/linuxbrew/.linuxbrew/bin/caprock",
];

/// What the shell knows about the daemon; the fallback page renders it.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum State {
    /// Launch: looking for a daemon.
    Searching,
    /// No daemon and the app has never started one: ask first (decision 7).
    FirstRun,
    /// Starting the bundled daemon; `step` says which part.
    Starting { step: String },
    /// A compatible daemon answers.
    Connected {
        port: u16,
        version: String,
        api_level: u32,
        ours: bool,
    },
    /// A daemon answers but is older than this app needs.
    TooOld {
        port: u16,
        version: String,
        api_level: u32,
        min_api_level: u32,
        ours: bool,
        /// The upgrade command for how it was installed, from `/v1/update`.
        command: String,
    },
    /// The daemon has been gone for `STOPPED_AFTER`; waiting for it.
    Stopped,
    /// Starting failed; `error` is what went wrong, verbatim.
    Failed { error: String },
}

/// The app's own choices, in `<data_dir>/app.json`. Its absence means the app
/// has never started a daemon here.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct Settings {
    /// Run the daemon as a login service (on) or only while started (off).
    pub background: bool,
    /// macOS: run the app's own daemon, moving a Homebrew one onto it
    /// (ADR-040). `"own_daemon": false` in app.json keeps whichever runs.
    #[serde(default = "yes", skip_serializing_if = "is_yes")]
    pub own_daemon: bool,
}

impl Settings {
    pub fn new(background: bool) -> Self {
        Self {
            background,
            own_daemon: true,
        }
    }
}

fn yes() -> bool {
    true
}

fn is_yes(v: &bool) -> bool {
    *v
}

pub struct Supervisor {
    pub data_dir: PathBuf,
    /// The sidecar shipped next to the app's executable.
    bundled: PathBuf,
    inner: Mutex<Inner>,
}

struct Inner {
    state: State,
    rt: Option<Runtime>,
    busy: bool,
    /// Set when a launch finds no daemon and the app has started one here
    /// before: the monitor starts it again the same way, with no question.
    autostart: bool,
    last_poll: Option<Instant>,
    /// The move of a Homebrew daemon onto the app's own has been tried in
    /// this run; it is tried once, whatever the outcome.
    adopt_tried: bool,
    /// The move of the app's own daemon onto a newer bundled copy has been
    /// tried in this run (after an app update); once, like the adoption.
    refresh_tried: bool,
}

impl Supervisor {
    pub fn new(data_dir: PathBuf) -> Arc<Self> {
        let bundled = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join(EXE)))
            .unwrap_or_else(|| PathBuf::from(EXE));
        Arc::new(Self {
            data_dir,
            bundled,
            inner: Mutex::new(Inner {
                state: State::Searching,
                rt: None,
                busy: false,
                autostart: false,
                last_poll: None,
                adopt_tried: false,
                refresh_tried: false,
            }),
        })
    }

    /// Where the app keeps its copy of the daemon. Not inside the app bundle:
    /// an unsigned app may run translocated from a read-only random path, and
    /// a login service must keep working after the app moves or is deleted.
    pub fn bin(&self) -> PathBuf {
        self.data_dir.join("bin").join(EXE)
    }

    pub fn state(&self) -> State {
        self.lock().state.clone()
    }

    pub fn runtime(&self) -> Option<Runtime> {
        self.lock().rt.clone()
    }

    /// Records that the page asked for the state: a page that polls owns the
    /// "daemon stopped" banner, so the shell need not navigate away.
    pub fn touch_poll(&self) {
        self.lock().last_poll = Some(Instant::now());
    }

    pub fn page_polls(&self) -> bool {
        self.lock()
            .last_poll
            .is_some_and(|t| t.elapsed() < Duration::from_secs(3))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn set(&self, state: State) {
        self.lock().state = state;
    }

    pub fn settings(&self) -> Option<Settings> {
        let raw = std::fs::read(self.data_dir.join("app.json")).ok()?;
        serde_json::from_slice(&raw).ok()
    }

    fn save_settings(&self, s: Settings) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.data_dir)?;
        let tmp = self.data_dir.join("app.json.tmp");
        std::fs::write(&tmp, serde_json::to_vec(&s)?)?;
        std::fs::rename(tmp, self.data_dir.join("app.json"))
    }

    /// One observation of the daemon, folded into the state. Returns the new
    /// state. `absent_for` is how long the daemon has been missing.
    pub fn observe(&self, found: Found, absent_for: Duration) -> State {
        let bin = self.bin();
        let mut g = self.lock();
        let next = match found {
            Found::Running { rt, status } => {
                let ours = discovery::is_ours(&rt, &bin);
                let port = rt.port;
                let rt_for_command = rt.clone();
                g.rt = Some(rt);
                if status.api_level < MIN_API_LEVEL {
                    let command = match &g.state {
                        State::TooOld {
                            command, port: p, ..
                        } if *p == port => command.clone(),
                        _ => upgrade_command(&rt_for_command),
                    };
                    State::TooOld {
                        port,
                        version: status.version,
                        api_level: status.api_level,
                        min_api_level: MIN_API_LEVEL,
                        ours,
                        command,
                    }
                } else {
                    State::Connected {
                        port,
                        version: status.version,
                        api_level: status.api_level,
                        ours,
                    }
                }
            }
            Found::Absent => match &g.state {
                _ if g.busy => g.state.clone(),
                State::Connected { .. } | State::TooOld { .. } if absent_for >= STOPPED_AFTER => {
                    State::Stopped
                }
                // A login service may be a moment away from listening; after
                // that, ask on a first run and start as before otherwise.
                State::Searching if absent_for >= Duration::from_millis(1500) => {
                    match self.settings() {
                        None => State::FirstRun,
                        Some(_) => {
                            g.autostart = true;
                            State::Starting {
                                step: "Starting the daemon".into(),
                            }
                        }
                    }
                }
                other => other.clone(),
            },
        };
        g.state = next.clone();
        next
    }

    /// Whether a launch asked for the daemon to be started as before; true
    /// once.
    pub fn take_autostart(&self) -> bool {
        std::mem::take(&mut self.lock().autostart)
    }

    /// Claims the supervisor for one start or update; false when another one
    /// is already running.
    fn claim(&self, step: &str) -> bool {
        let mut g = self.lock();
        if g.busy {
            return false;
        }
        g.busy = true;
        g.state = State::Starting { step: step.into() };
        true
    }

    /// Starts the daemon on a background thread: copy the bundled binary,
    /// register the login service when asked, and fall back to `caprock up`
    /// if the service did not bring it up.
    pub fn spawn_start(self: &Arc<Self>, background: bool) {
        if !self.claim("Starting the daemon") {
            return;
        }
        let sup = self.clone();
        thread::spawn(move || sup.start(background));
    }

    /// Updates an outdated daemon this app installed, on a background thread.
    pub fn spawn_update(self: &Arc<Self>) {
        if !self.claim("Updating the daemon") {
            return;
        }
        let sup = self.clone();
        thread::spawn(move || match sup.stop_for_update() {
            Ok(()) => sup.start(sup.settings().is_none_or(|s| s.background)),
            Err(error) => sup.finish(Err(error)),
        });
    }

    /// macOS (ADR-040): whether the running daemon should be moved onto the
    /// app's own — a Homebrew formula's daemon, not already tried in this run,
    /// not refused in app.json, and not newer than the bundled one (`bundled`
    /// is the bundled daemon's version, asked only when the rest holds).
    pub fn should_adopt(&self, bundled: impl FnOnce() -> Option<String>) -> bool {
        if !cfg!(target_os = "macos") || self.settings().is_some_and(|s| !s.own_daemon) {
            return false;
        }
        let (rt, running) = {
            let g = self.lock();
            if g.adopt_tried || g.busy {
                return false;
            }
            let running = match &g.state {
                State::Connected {
                    version,
                    ours: false,
                    ..
                }
                | State::TooOld {
                    version,
                    ours: false,
                    ..
                } => version.clone(),
                _ => return false,
            };
            match &g.rt {
                Some(rt) => (rt.clone(), running),
                None => return false,
            }
        };
        if !is_formula(&rt.exe) {
            return false;
        }
        self.lock().adopt_tried = true;
        match (bundled().as_deref().and_then(semver), semver(&running)) {
            (Some(ours), Some(theirs)) => ours >= theirs,
            _ => false,
        }
    }

    /// Whether the app's own daemon should move onto the bundled copy: it
    /// runs from `<data_dir>/bin` (this app installed it) and is older than
    /// the daemon this bundle carries — what an app update (F20) or a cask
    /// upgrade leaves behind. Tried once per run; `bundled` is the bundled
    /// daemon's version, asked only when the rest holds. A daemon a package
    /// manager owns is never touched.
    pub fn should_refresh(&self, bundled: impl FnOnce() -> Option<String>) -> bool {
        let running = {
            let g = self.lock();
            if g.refresh_tried || g.busy {
                return false;
            }
            match &g.state {
                State::Connected {
                    version,
                    ours: true,
                    ..
                } => version.clone(),
                _ => return false,
            }
        };
        self.lock().refresh_tried = true;
        newer(bundled().as_deref(), &running)
    }

    /// Moves a running Homebrew daemon onto the app's own copy, on a
    /// background thread: the copy in place, a clean shutdown through the
    /// daemon's API (sessions live on in their pty-hosts, ADR-033), then a
    /// start as a login service when one was registered or chosen.
    pub fn spawn_adopt(self: &Arc<Self>) {
        let Some(rt) = self.runtime() else { return };
        if !self.claim("Moving the daemon into the app") {
            return;
        }
        let sup = self.clone();
        thread::spawn(move || {
            let background =
                sup.settings().is_none_or(|s| s.background) || launch_agent_registered();
            let stopped = install_bin(&sup.bundled, &sup.bin()).and_then(|()| {
                let _ = discovery::request(rt.port, "POST", "/v1/shutdown", Some(&rt.token));
                let deadline = Instant::now() + Duration::from_secs(10);
                while Instant::now() < deadline && discovery::status(rt.port).is_some() {
                    thread::sleep(Duration::from_millis(200));
                }
                if discovery::status(rt.port).is_some() {
                    return Err("The Homebrew daemon did not stop; it keeps running.".into());
                }
                Ok(())
            });
            match stopped {
                Ok(()) => sup.start(background),
                Err(error) => sup.finish(Err(error)),
            }
        });
    }

    /// The bundled daemon's version, from `caprock version`.
    pub fn bundled_version(&self) -> Option<String> {
        let mut cmd = Command::new(&self.bundled);
        cmd.arg("version");
        no_console(&mut cmd);
        let out = cmd.output().ok()?;
        out.status
            .success()
            .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
    }

    /// The start itself; the caller has claimed the supervisor.
    fn start(&self, background: bool) {
        let result = self.start_inner(background);
        self.finish(result);
    }

    /// Ends a start or update: releases the claim and records the outcome.
    fn finish(&self, result: Result<(), String>) {
        if let Err(error) = result {
            let mut g = self.lock();
            g.busy = false;
            g.state = State::Failed { error };
            return;
        }
        let found = discovery::find(&self.data_dir);
        self.lock().busy = false;
        self.observe(found, Duration::ZERO);
    }

    fn start_inner(&self, background: bool) -> Result<(), String> {
        self.save_settings(Settings {
            background,
            ..self.settings().unwrap_or(Settings::new(background))
        })
        .map_err(|e| format!("save app.json: {e}"))?;
        if matches!(discovery::find(&self.data_dir), Found::Running { .. }) {
            return Ok(()); // someone else started one meanwhile: use it
        }
        // macOS starts its own copy, at one path that never changes (ADR-040).
        let brew = if cfg!(target_os = "macos") {
            None
        } else {
            brew_daemon(BREW_BINS)
        };
        let exe = match brew {
            Some(exe) => exe,
            None => {
                self.set(State::Starting {
                    step: "Installing the Caprock daemon".into(),
                });
                install_bin(&self.bundled, &self.bin())?;
                self.bin()
            }
        };
        let mut service_err = String::new();
        if background {
            self.set(State::Starting {
                step: "Registering the background service".into(),
            });
            if let Err(e) = self.run(&exe, &["service", "install"]) {
                service_err = e;
            }
            if self.wait_up(Duration::from_secs(6)) {
                return Ok(());
            }
        }
        self.set(State::Starting {
            step: "Starting the daemon".into(),
        });
        // `up` itself waits up to 10 s for the daemon and says why it failed
        // (most often: the port is taken), so a failure needs no second wait.
        let up = self.run(&exe, &["up", "--no-open", "--no-hooks"]);
        let wait = if up.is_ok() {
            Duration::from_secs(10)
        } else {
            Duration::from_secs(1)
        };
        if self.wait_up(wait) {
            return Ok(());
        }
        let mut msg = up
            .err()
            .unwrap_or_else(|| "the daemon did not answer within 10 s".into());
        if !service_err.is_empty() {
            msg = format!("{msg}\n\nservice install: {service_err}");
        }
        Err(msg)
    }

    /// Prepares an update of an outdated daemon this app installed: the new
    /// binary in place, then a clean shutdown through the daemon's own API.
    fn stop_for_update(&self) -> Result<(), String> {
        let rt = self
            .runtime()
            .filter(|rt| discovery::is_ours(rt, &self.bin()))
            .ok_or("This daemon was not installed by the app: upgrade it with its own command.")?;
        install_bin(&self.bundled, &self.bin())?;
        self.set(State::Starting {
            step: "Restarting the daemon".into(),
        });
        let _ = discovery::request(rt.port, "POST", "/v1/shutdown", Some(&rt.token));
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline && discovery::status(rt.port).is_some() {
            thread::sleep(Duration::from_millis(200));
        }
        Ok(())
    }

    /// Turns the login service on or off for whichever daemon binary runs
    /// (the running one's own `exe`, else ours), so a Homebrew daemon is
    /// registered as itself rather than swapped for the bundled copy.
    pub fn set_background(&self, on: bool) -> Result<(), String> {
        self.save_settings(Settings {
            background: on,
            ..self.settings().unwrap_or(Settings::new(on))
        })
        .map_err(|e| e.to_string())?;
        let exe = self
            .runtime()
            .map(|rt| PathBuf::from(rt.exe))
            .filter(|p| p.is_file())
            .unwrap_or_else(|| self.bin());
        if !exe.is_file() {
            return Ok(()); // nothing installed yet: the choice applies at start
        }
        let verb = if on { "install" } else { "uninstall" };
        self.run(&exe, &["service", verb]).map(|_| ())
    }

    fn wait_up(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if matches!(discovery::find(&self.data_dir), Found::Running { .. }) {
                return true;
            }
            thread::sleep(Duration::from_millis(200));
        }
        false
    }

    /// Runs the daemon binary with fixed arguments and this data directory.
    fn run(&self, exe: &Path, args: &[&str]) -> Result<Output, String> {
        let mut cmd = Command::new(exe);
        cmd.args(args).env("CAPROCK_DATA_DIR", &self.data_dir);
        no_console(&mut cmd);
        let out = cmd
            .output()
            .map_err(|e| format!("{} {}: {e}", exe.display(), args.join(" ")))?;
        if out.status.success() {
            return Ok(out);
        }
        let text = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let text = if text.is_empty() {
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        } else {
            text
        };
        Err(format!("caprock {} failed: {text}", args.join(" ")))
    }
}

/// How to upgrade the daemon: its own answer (`/v1/update` names a command
/// only once it has seen a newer release), else the same inference from the
/// binary's path; empty when no package manager owns it.
fn upgrade_command(rt: &Runtime) -> String {
    #[derive(Deserialize)]
    struct Update {
        #[serde(default)]
        command: String,
    }
    let told = discovery::request(rt.port, "GET", "/v1/update", None)
        .ok()
        .and_then(|(_, body)| serde_json::from_str::<Update>(&body).ok())
        .map(|u| u.command)
        .unwrap_or_default();
    if !told.is_empty() {
        return told;
    }
    let exe = if rt.exe.is_empty() {
        discovery::exe_of_pid(rt.pid)
    } else {
        rt.exe.clone()
    };
    discovery::command_for_path(&exe).to_string()
}

/// The `caprock` formula's binary when Homebrew installed one: the first of
/// `candidates` that resolves into a Cellar. Starting it rather than the
/// bundled copy keeps one daemon on the machine, upgraded by `brew upgrade`.
/// A file there that Homebrew does not own is not used.
pub fn brew_daemon(candidates: &[&str]) -> Option<PathBuf> {
    candidates.iter().map(Path::new).find_map(|p| {
        let real = std::fs::canonicalize(p).ok()?;
        let owned = real.to_string_lossy().contains("/Cellar/");
        (owned && real.is_file()).then(|| p.to_path_buf())
    })
}

/// Whether `exe` resolves into a Homebrew Cellar: the formula's daemon.
pub fn is_formula(exe: &str) -> bool {
    !exe.is_empty()
        && std::fs::canonicalize(exe)
            .unwrap_or_else(|_| PathBuf::from(exe))
            .to_string_lossy()
            .contains("/Cellar/")
}

/// The first `X.Y.Z` in `s` ("caprock 0.78.0 (darwin/arm64)", "v0.78.0"),
/// for comparing; `None` for a dev build.
pub fn semver(s: &str) -> Option<(u64, u64, u64)> {
    s.split(|c: char| !(c.is_ascii_digit() || c == '.'))
        .find_map(|tok| {
            let mut it = tok.split('.').map(|n| n.parse::<u64>().ok());
            match (it.next(), it.next(), it.next()) {
                (Some(Some(a)), Some(Some(b)), Some(Some(c))) => Some((a, b, c)),
                _ => None,
            }
        })
}

/// Whether `bundled` names a strictly newer version than `running`; false
/// when either is not a version (a development build says `dev`).
pub fn newer(bundled: Option<&str>, running: &str) -> bool {
    match (bundled.and_then(semver), semver(running)) {
        (Some(b), Some(r)) => b > r,
        _ => false,
    }
}

/// macOS: whether a login service for this label is registered (its plist
/// exists), so a moved daemon comes back the same way.
fn launch_agent_registered() -> bool {
    let label = std::env::var("CAPROCK_SERVICE_LABEL")
        .ok()
        .filter(|l| !l.is_empty())
        .unwrap_or_else(|| "dev.caprock.daemon".into());
    dirs::home_dir().is_some_and(|h| {
        h.join("Library/LaunchAgents")
            .join(format!("{label}.plist"))
            .is_file()
    })
}

/// Copies the bundled daemon to `dst` when it differs, atomically (write a
/// sibling, then rename over: a running binary is never written in place).
pub fn install_bin(src: &Path, dst: &Path) -> Result<(), String> {
    let want = std::fs::read(src)
        .map_err(|e| format!("read the bundled daemon {}: {e}", src.display()))?;
    if std::fs::read(dst).is_ok_and(|have| have == want) {
        return Ok(());
    }
    let dir = dst.parent().ok_or("no bin directory")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let tmp = dir.join(format!(".{EXE}.new"));
    std::fs::write(&tmp, &want).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("chmod {}: {e}", tmp.display()))?;
    }
    #[cfg(windows)]
    {
        // A running .exe cannot be replaced, but it can be renamed aside.
        let old = dir.join(format!(".{EXE}.old"));
        let _ = std::fs::remove_file(&old);
        let _ = std::fs::rename(dst, &old);
    }
    std::fs::rename(&tmp, dst).map_err(|e| format!("install {}: {e}", dst.display()))
}

#[cfg(windows)]
fn no_console(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn no_console(_: &mut Command) {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::discovery::Status;

    fn sup(name: &str) -> Arc<Supervisor> {
        let d = std::env::temp_dir().join(format!("caprock-sup-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        Supervisor::new(d)
    }

    fn running(level: u32, exe: &str) -> Found {
        Found::Running {
            rt: Runtime {
                port: 1,
                token: "t".into(),
                pid: 1,
                version: "v".into(),
                api_level: level,
                exe: exe.into(),
            },
            status: Status {
                version: "v".into(),
                api_level: level,
            },
        }
    }

    fn running_v(level: u32, exe: &str, version: &str) -> Found {
        match running(level, exe) {
            Found::Running { rt, mut status } => {
                status.version = version.into();
                Found::Running { rt, status }
            }
            other => other,
        }
    }

    #[test]
    fn a_compatible_daemon_connects_and_an_old_one_is_refused() {
        let s = sup("levels");
        assert!(matches!(
            s.observe(running(MIN_API_LEVEL, ""), Duration::ZERO),
            State::Connected { .. }
        ));
        match s.observe(running(0, "/opt/homebrew/bin/caprock"), Duration::ZERO) {
            State::TooOld {
                ours,
                min_api_level,
                ..
            } => {
                assert!(!ours);
                assert_eq!(min_api_level, MIN_API_LEVEL);
            }
            other => panic!("expected too_old, got {other:?}"),
        }
    }

    #[test]
    fn a_daemon_that_goes_away_reads_stopped_after_a_moment() {
        let s = sup("stop");
        s.observe(running(MIN_API_LEVEL, ""), Duration::ZERO);
        assert!(matches!(
            s.observe(Found::Absent, Duration::from_millis(900)),
            State::Connected { .. }
        ));
        assert_eq!(s.observe(Found::Absent, STOPPED_AFTER), State::Stopped);
        assert!(matches!(
            s.observe(running(MIN_API_LEVEL, ""), Duration::ZERO),
            State::Connected { .. }
        ));
    }

    #[test]
    fn no_daemon_on_launch_asks_before_starting_one() {
        let s = sup("first");
        assert_eq!(
            s.observe(Found::Absent, Duration::from_millis(200)),
            State::Searching
        );
        assert_eq!(
            s.observe(Found::Absent, Duration::from_secs(2)),
            State::FirstRun
        );
        assert_eq!(s.settings(), None);
    }

    #[test]
    fn install_bin_copies_once_and_replaces_a_changed_binary() {
        let s = sup("bin");
        let src = s.data_dir.join("src-caprock");
        std::fs::create_dir_all(&s.data_dir).unwrap();
        std::fs::write(&src, b"v1").unwrap();
        install_bin(&src, &s.bin()).unwrap();
        assert_eq!(std::fs::read(s.bin()).unwrap(), b"v1");
        std::fs::write(&src, b"v2").unwrap();
        install_bin(&src, &s.bin()).unwrap();
        assert_eq!(std::fs::read(s.bin()).unwrap(), b"v2");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(s.bin()).unwrap().permissions().mode();
            assert_eq!(
                mode & 0o111,
                0o111,
                "the installed daemon must be executable"
            );
        }
        assert!(install_bin(&s.data_dir.join("missing"), &s.bin()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn brew_daemon_takes_only_a_binary_in_a_cellar() {
        let s = sup("brew");
        let cellar = s.data_dir.join("Cellar/caprock/1.0.0/bin");
        std::fs::create_dir_all(&cellar).unwrap();
        std::fs::write(cellar.join("caprock"), b"x").unwrap();
        let loose = s.data_dir.join("loose");
        std::fs::write(&loose, b"x").unwrap();
        let link = s.data_dir.join("caprock");
        std::os::unix::fs::symlink(cellar.join("caprock"), &link).unwrap();
        let (loose, link) = (loose.to_str().unwrap(), link.to_str().unwrap());
        assert_eq!(brew_daemon(&[loose, "/nonexistent/caprock"]), None);
        assert_eq!(brew_daemon(&[loose, link]), Some(PathBuf::from(link)));
    }

    #[test]
    fn the_apps_own_daemon_moves_onto_a_newer_bundled_copy_once() {
        let s = sup("refresh");
        // Not ours (a package manager's): never.
        s.observe(
            running_v(MIN_API_LEVEL, "/opt/homebrew/bin/caprock", "0.78.0"),
            Duration::ZERO,
        );
        assert!(!s.should_refresh(|| Some("caprock 0.79.0 (abc)".into())));
        // Ours and older than the bundle: once.
        let bin = s.bin();
        std::fs::create_dir_all(bin.parent().unwrap()).unwrap();
        std::fs::write(&bin, b"x").unwrap();
        s.observe(
            running_v(MIN_API_LEVEL, bin.to_str().unwrap(), "0.78.0"),
            Duration::ZERO,
        );
        assert!(s.should_refresh(|| Some("caprock 0.79.0 (abc)".into())));
        assert!(
            !s.should_refresh(|| Some("caprock 0.79.0 (abc)".into())),
            "once per run"
        );
    }

    #[test]
    fn the_apps_own_daemon_stays_when_not_older() {
        let s = sup("refresh-same");
        let bin = s.bin();
        std::fs::create_dir_all(bin.parent().unwrap()).unwrap();
        std::fs::write(&bin, b"x").unwrap();
        s.observe(
            running_v(MIN_API_LEVEL, bin.to_str().unwrap(), "0.79.0"),
            Duration::ZERO,
        );
        assert!(!s.should_refresh(|| Some("caprock 0.79.0 (abc)".into())));
        assert!(newer(Some("caprock 0.79.1"), "0.79.0"));
        assert!(!newer(Some("caprock dev"), "0.79.0"));
        assert!(!newer(Some("caprock 0.79.0"), "dev"));
        assert!(!newer(None, "0.79.0"));
    }

    #[test]
    fn settings_round_trip_and_mark_the_first_run_done() {
        let s = sup("settings");
        s.save_settings(Settings::new(false)).unwrap();
        assert_eq!(s.settings(), Some(Settings::new(false)));
    }
}

#[cfg(test)]
mod adopt_tests {
    use super::*;
    use crate::discovery::Status;

    fn sup(name: &str) -> Arc<Supervisor> {
        let d = std::env::temp_dir().join(format!("caprock-adopt-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        Supervisor::new(d)
    }

    /// A fake formula daemon: a file in `<tmp>/Cellar/caprock/<v>/bin`.
    fn formula(s: &Supervisor) -> String {
        let dir = s.data_dir.join("Cellar/caprock/0.78.0/bin");
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("caprock");
        std::fs::write(&exe, b"x").unwrap();
        exe.to_string_lossy().into_owned()
    }

    fn connect(s: &Supervisor, exe: &str, version: &str) {
        s.observe(
            Found::Running {
                rt: Runtime {
                    port: 1,
                    token: "t".into(),
                    pid: 1,
                    version: version.into(),
                    api_level: MIN_API_LEVEL,
                    exe: exe.into(),
                },
                status: Status {
                    version: version.into(),
                    api_level: MIN_API_LEVEL,
                },
            },
            Duration::ZERO,
        );
    }

    #[test]
    fn versions_are_read_from_what_the_binaries_say() {
        assert_eq!(semver("caprock 0.78.0 (darwin/arm64)"), Some((0, 78, 0)));
        assert_eq!(semver("v0.79.1"), Some((0, 79, 1)));
        assert_eq!(semver("dev"), None);
        assert!(semver("0.79.0") > semver("0.78.9"));
    }

    // Homebrew paths are POSIX; there is no Cellar on Windows.
    #[cfg(unix)]
    #[test]
    fn a_formula_path_is_one_in_a_cellar() {
        let s = sup("formula");
        assert!(is_formula(&formula(&s)));
        assert!(!is_formula(&s.bin().to_string_lossy()));
        assert!(!is_formula(""));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_moves_a_homebrew_daemon_once_when_its_own_is_not_older() {
        let s = sup("once");
        let exe = formula(&s);
        connect(&s, &exe, "0.78.0");
        assert!(s.should_adopt(|| Some("caprock 0.78.0 (darwin/arm64)".into())));
        // Tried once per run, whatever came of it.
        assert!(!s.should_adopt(|| Some("caprock 0.78.0".into())));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_leaves_a_newer_homebrew_daemon_and_any_other_daemon_alone() {
        let s = sup("newer");
        let exe = formula(&s);
        connect(&s, &exe, "0.79.0");
        assert!(!s.should_adopt(|| Some("caprock 0.78.0".into())));

        let s = sup("dev");
        connect(&s, "/Users/me/dev/wt/caprock/caprock", "dev");
        assert!(!s.should_adopt(|| panic!("not asked for a daemon that is not a formula's")));

        let s = sup("unknown");
        let exe = formula(&s);
        connect(&s, &exe, "0.78.0");
        assert!(!s.should_adopt(|| None));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_keeps_the_homebrew_daemon_when_app_json_says_so() {
        let s = sup("refused");
        s.save_settings(Settings {
            background: true,
            own_daemon: false,
        })
        .unwrap();
        // A later choice of background keeps the refusal.
        s.set_background(false).unwrap();
        assert_eq!(s.settings().map(|x| x.own_daemon), Some(false));
        let exe = formula(&s);
        connect(&s, &exe, "0.78.0");
        assert!(!s.should_adopt(|| Some("caprock 0.79.0".into())));
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn elsewhere_a_homebrew_daemon_is_never_moved() {
        let s = sup("other");
        let exe = formula(&s);
        connect(&s, &exe, "0.78.0");
        assert!(!s.should_adopt(|| Some("caprock 0.79.0".into())));
    }
}
