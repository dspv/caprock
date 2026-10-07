//! App updates (F20, WP-21, ADR-042): one click from "a newer Caprock is
//! out" to the new app running, through `tauri-plugin-updater`.
//!
//! - **What tells us an update exists** is the daemon's release check
//!   (`/v1/update`, off until the user turns it on). The app makes no
//!   periodic request of its own: it fetches `latest.json` only when the
//!   user clicks **Update** or **Check for Updates…** (rule 4).
//! - **Nothing installs without a valid signature.** The bundle is verified
//!   against the public key in `tauri.conf.json` (minisign) and the version
//!   it was signed for, before a byte of it is written.
//! - **Sessions survive.** The new bundle carries the new daemon; the
//!   relaunched app moves its own daemon onto it with a clean shutdown
//!   (`Supervisor::should_adopt`, ADR-040), and sessions live on in their
//!   pty-hosts (ADR-033).
//! - **Where it cannot update itself** (a development build, a .deb or .rpm
//!   install, a macOS app run from the disk image or a translocated copy)
//!   it says what to do instead and never tries.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::utils::config::BundleType;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_updater::{Update, UpdaterExt};

/// The event the page listens for (`ui/src/lib/appupdate.ts`); its detail is
/// the [`Info`].
pub const EVENT: &str = "caprock:app-update";

/// Progress is sent at most this often while downloading.
const PROGRESS_EVERY: Duration = Duration::from_millis(200);

/// How long the page gets to save its state before the app restarts.
const SETTLE: Duration = Duration::from_millis(1000);

async fn tokio_sleep(d: Duration) {
    let (tx, rx) = tauri::async_runtime::channel::<()>(1);
    std::thread::spawn(move || {
        std::thread::sleep(d);
        let _ = tx.blocking_send(());
    });
    let mut rx = rx;
    let _ = rx.recv().await;
}

/// How long a check or a download may take before it is called failed.
const TIMEOUT: Duration = Duration::from_secs(120);

/// Where the updater stands. `next` is the version on offer (`version` in
/// [`Info`] is this app's own; the two sit side by side in one object).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "phase", rename_all = "snake_case")]
pub enum Phase {
    /// Nothing asked yet in this run.
    Idle,
    Checking,
    /// The last check found nothing newer than this app.
    UpToDate,
    /// A signed update for this platform is published.
    Available {
        next: String,
    },
    Downloading {
        next: String,
        downloaded: u64,
        total: Option<u64>,
    },
    /// Verified; being put in place. The app restarts right after.
    Installing {
        next: String,
    },
    /// `error` is what went wrong, in words a user can act on.
    Failed {
        error: String,
    },
}

/// What the page renders.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Info {
    /// This app's own version.
    pub version: String,
    /// Whether this install can update itself; `blocked` says why not.
    pub supported: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked: Option<String>,
    /// The first-launch question about update checks has been answered.
    pub asked: bool,
    #[serde(flatten)]
    pub phase: Phase,
}

/// The app's update state, managed by Tauri.
pub struct Updates {
    file: PathBuf,
    phase: Mutex<Phase>,
    pending: Mutex<Option<Update>>,
    busy: Mutex<bool>,
}

/// `<data_dir>/app-update.json`: the one thing the updater remembers. Kept
/// out of `app.json`, whose absence means "never started a daemon here".
#[derive(Debug, Default, Serialize, Deserialize, PartialEq)]
struct Saved {
    #[serde(default)]
    asked: bool,
}

impl Updates {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            file: data_dir.join("app-update.json"),
            phase: Mutex::new(Phase::Idle),
            pending: Mutex::new(None),
            busy: Mutex::new(false),
        }
    }

    fn saved(&self) -> Saved {
        std::fs::read(&self.file)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    pub fn mark_asked(&self) -> std::io::Result<()> {
        if let Some(dir) = self.file.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = self.file.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec(&Saved { asked: true })?)?;
        std::fs::rename(tmp, &self.file)
    }

    pub fn phase(&self) -> Phase {
        self.phase.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn set_phase(&self, p: Phase) {
        *self.phase.lock().unwrap_or_else(|e| e.into_inner()) = p;
    }

    pub fn info(&self, version: &str, blocked: Option<String>) -> Info {
        Info {
            version: version.to_string(),
            supported: blocked.is_none(),
            blocked,
            asked: self.saved().asked,
            phase: self.phase(),
        }
    }

    /// Claims the updater for one check or install; false while another runs.
    fn claim(&self) -> bool {
        let mut b = self.busy.lock().unwrap_or_else(|e| e.into_inner());
        !std::mem::replace(&mut *b, true)
    }

    fn release(&self) {
        *self.busy.lock().unwrap_or_else(|e| e.into_inner()) = false;
    }
}

/// Why this copy cannot replace itself, or `None` when it can. Pure, for
/// tests: `bundle` is how it was packaged, `exe` where it runs from.
pub fn blocked(bundle: Option<BundleType>, exe: &Path, dev: bool) -> Option<String> {
    if dev {
        return Some("A development build does not update itself.".into());
    }
    let path = exe.to_string_lossy();
    match bundle {
        Some(BundleType::App) | Some(BundleType::Dmg) => {
            if path.contains("/AppTranslocation/") || path.starts_with("/Volumes/") {
                return Some(
                    "Move Caprock to Applications and open it from there: macOS runs it from a \
                     read-only copy until then."
                        .into(),
                );
            }
            None
        }
        Some(BundleType::Nsis) | Some(BundleType::AppImage) => None,
        Some(BundleType::Deb) => Some(
            "Installed from the .deb package: install the new Caprock-Linux.deb from the release \
             page with your package manager."
                .into(),
        ),
        Some(BundleType::Rpm) => Some(
            "Installed from the .rpm package: install the new Caprock-Linux.rpm from the release \
             page with your package manager."
                .into(),
        ),
        _ => Some(
            "This copy was not installed from a release bundle: download the new one from the \
             release page."
                .into(),
        ),
    }
}

fn this_blocked() -> Option<String> {
    let exe = std::env::current_exe().unwrap_or_default();
    blocked(
        tauri::utils::platform::bundle_type(),
        &exe,
        cfg!(debug_assertions),
    )
}

/// The current [`Info`].
pub fn info<R: Runtime>(app: &AppHandle<R>) -> Info {
    let version = app.package_info().version.to_string();
    app.state::<Updates>().info(&version, this_blocked())
}

/// Tells the page where the updater stands.
fn announce<R: Runtime>(app: &AppHandle<R>) {
    let Some(w) = app.get_webview_window(crate::shell::MAIN) else {
        return;
    };
    let Ok(detail) = serde_json::to_string(&info(app)) else {
        return;
    };
    let _ = w.eval(format!(
        "window.dispatchEvent(new CustomEvent('{EVENT}', {{ detail: {detail} }}))"
    ));
}

/// An updater error in words a user can act on.
pub fn explain(e: &tauri_plugin_updater::Error) -> String {
    use tauri_plugin_updater::Error as E;
    match e {
        // A release without latest.json (published before updates were
        // signed, or still being built) answers 404, which the plugin
        // reports as no release found; the same for a platform missing
        // from it.
        E::ReleaseNotFound | E::TargetNotFound(_) | E::TargetsNotFound(_) => {
            "No signed update for this platform is published yet: download it from the release \
             page."
                .into()
        }
        E::Minisign(_) | E::SignatureUtf8(_) | E::Base64(_) => {
            "The update's signature did not verify, so nothing was installed.".into()
        }
        E::SignedVersionMismatch { .. } | E::MissingSignedVersion => {
            "The update was signed for a different version, so nothing was installed.".into()
        }
        E::Reqwest(_) | E::Network(_) => {
            format!("Could not reach GitHub: {e}")
        }
        _ => e.to_string(),
    }
}

/// Fetches `latest.json` once and records what it says. The one request
/// the app itself makes; only on a click (a menu item, the palette, or
/// Update).
pub async fn check<R: Runtime>(app: AppHandle<R>) -> Info {
    let st = app.state::<Updates>();
    if this_blocked().is_some() || !st.claim() {
        return info(&app);
    }
    st.set_phase(Phase::Checking);
    announce(&app);
    let result = check_once(&app).await;
    st.set_phase(match result {
        Ok(Some(u)) => {
            let version = u.version.clone();
            *st.pending.lock().unwrap_or_else(|e| e.into_inner()) = Some(u);
            Phase::Available { next: version }
        }
        Ok(None) => Phase::UpToDate,
        Err(e) => Phase::Failed { error: e },
    });
    st.release();
    announce(&app);
    info(&app)
}

async fn check_once<R: Runtime>(app: &AppHandle<R>) -> Result<Option<Update>, String> {
    let updater = app
        .updater_builder()
        .timeout(TIMEOUT)
        .build()
        .map_err(|e| explain(&e))?;
    updater.check().await.map_err(|e| explain(&e))
}

/// Downloads, verifies and installs the update, then restarts the app. On
/// Windows the installer takes over and the app exits from inside the
/// plugin. Returns only when something failed.
pub async fn install<R: Runtime>(app: AppHandle<R>) -> Info {
    let st = app.state::<Updates>();
    if this_blocked().is_some() || !st.claim() {
        return info(&app);
    }
    let pending = st.pending.lock().unwrap_or_else(|e| e.into_inner()).take();
    let update = match pending {
        Some(u) => Ok(Some(u)),
        None => {
            st.set_phase(Phase::Checking);
            announce(&app);
            check_once(&app).await
        }
    };
    let update = match update {
        Ok(Some(u)) => u,
        Ok(None) => {
            st.set_phase(Phase::UpToDate);
            st.release();
            announce(&app);
            return info(&app);
        }
        Err(error) => {
            st.set_phase(Phase::Failed { error });
            st.release();
            announce(&app);
            return info(&app);
        }
    };
    let version = update.version.clone();
    st.set_phase(Phase::Downloading {
        next: version.clone(),
        downloaded: 0,
        total: None,
    });
    announce(&app);
    let mut downloaded: u64 = 0;
    let mut last = Instant::now();
    let progress_app = app.clone();
    let progress_version = version.clone();
    let bytes = update
        .download(
            move |chunk, total| {
                downloaded += chunk as u64;
                progress_app
                    .state::<Updates>()
                    .set_phase(Phase::Downloading {
                        next: progress_version.clone(),
                        downloaded,
                        total,
                    });
                if last.elapsed() >= PROGRESS_EVERY {
                    last = Instant::now();
                    announce(&progress_app);
                }
            },
            || {},
        )
        .await;
    let bytes = match bytes {
        Ok(b) => b,
        Err(e) => {
            st.set_phase(Phase::Failed { error: explain(&e) });
            st.release();
            announce(&app);
            return info(&app);
        }
    };
    st.set_phase(Phase::Installing {
        next: version.clone(),
    });
    announce(&app);
    // Everything comes back where it was. The page keeps tabs, splits, the
    // front tab and the sidebar in its storage and, hearing "installing",
    // writes where each terminal is scrolled; give WebKit a moment to put
    // that on disk before this process goes (on Windows the installer ends
    // it from inside install()). The window's size and place are saved
    // now rather than trusted to the exit path.
    tokio_sleep(SETTLE).await;
    {
        use tauri_plugin_window_state::{AppHandleExt, StateFlags};
        let _ = app.save_window_state(StateFlags::all() & !StateFlags::VISIBLE);
    }
    if let Err(e) = update.install(bytes) {
        st.set_phase(Phase::Failed { error: explain(&e) });
        st.release();
        announce(&app);
        return info(&app);
    }
    // macOS and Linux: the new bundle is in place; start it. The daemon
    // runs from <data_dir>/bin, outside the bundle, and is moved onto the
    // new one by the relaunched app.
    app.restart();
}

/// A check from a menu item: bring the window up so the answer is seen.
pub fn check_from_menu<R: Runtime>(app: &AppHandle<R>) {
    crate::hotkey::show(app);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        check(app).await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("caprock-upd-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn a_release_bundle_updates_itself_and_others_say_what_to_do() {
        let app = Path::new("/Applications/Caprock.app/Contents/MacOS/caprock-app");
        assert_eq!(blocked(Some(BundleType::App), app, false), None);
        let exe = Path::new("C:/Program Files/Caprock/caprock-app.exe");
        assert_eq!(blocked(Some(BundleType::Nsis), exe, false), None);
        let img = Path::new("/home/me/Apps/Caprock.AppImage");
        assert_eq!(blocked(Some(BundleType::AppImage), img, false), None);

        let deb = blocked(
            Some(BundleType::Deb),
            Path::new("/usr/bin/caprock-app"),
            false,
        );
        assert!(deb.unwrap().contains("package manager"));
        let rpm = blocked(
            Some(BundleType::Rpm),
            Path::new("/usr/bin/caprock-app"),
            false,
        );
        assert!(rpm.unwrap().contains(".rpm"));
        assert!(blocked(None, Path::new("/x/caprock-app"), false).is_some());
        assert!(blocked(Some(BundleType::App), app, true)
            .unwrap()
            .contains("development build"));
    }

    #[test]
    fn a_mac_app_run_from_a_read_only_copy_is_not_replaced() {
        for p in [
            "/private/var/folders/x/T/AppTranslocation/ABC/d/Caprock.app/Contents/MacOS/caprock-app",
            "/Volumes/Caprock/Caprock.app/Contents/MacOS/caprock-app",
        ] {
            let why = blocked(Some(BundleType::App), Path::new(p), false).expect(p);
            assert!(why.contains("Applications"), "{p}: {why}");
        }
    }

    #[test]
    fn the_question_is_asked_once_and_remembered_apart_from_app_json() {
        let d = dir("asked");
        let u = Updates::new(&d);
        assert!(!u.info("1.0.0", None).asked);
        u.mark_asked().unwrap();
        assert!(Updates::new(&d).info("1.0.0", None).asked);
        assert!(
            !d.join("app.json").exists(),
            "app.json means a daemon was started"
        );
    }

    #[test]
    fn info_says_why_an_install_cannot_update() {
        let u = Updates::new(&dir("info"));
        let i = u.info(
            "0.79.0",
            Some("A development build does not update itself.".into()),
        );
        assert!(!i.supported);
        let v = serde_json::to_value(&i).unwrap();
        assert_eq!(v["phase"], "idle");
        assert_eq!(v["version"], "0.79.0");
        assert!(v["blocked"].as_str().unwrap().contains("development"));
        let ok = serde_json::to_value(u.info("0.79.0", None)).unwrap();
        assert_eq!(ok["supported"], true);
        assert!(ok.get("blocked").is_none());
    }

    #[test]
    fn phases_serialise_flat_for_the_page() {
        let u = Updates::new(&dir("phase"));
        u.set_phase(Phase::Downloading {
            next: "0.79.0".into(),
            downloaded: 10,
            total: Some(40),
        });
        let v = serde_json::to_value(u.info("0.78.1", None)).unwrap();
        assert_eq!(v["phase"], "downloading");
        assert_eq!(v["downloaded"], 10);
        assert_eq!(v["next"], "0.79.0");
        assert_eq!(v["version"], "0.78.1");
        assert_eq!(v["total"], 40);
    }

    #[test]
    fn one_check_or_install_at_a_time() {
        let u = Updates::new(&dir("claim"));
        assert!(u.claim());
        assert!(!u.claim());
        u.release();
        assert!(u.claim());
    }

    #[test]
    fn errors_read_as_what_to_do() {
        use tauri_plugin_updater::Error as E;
        assert!(explain(&E::ReleaseNotFound).contains("release page"));
        assert!(explain(&E::TargetsNotFound(vec!["darwin-aarch64".into()])).contains("platform"));
        assert!(explain(&E::MissingSignedVersion).contains("nothing was installed"));
        assert!(explain(&E::SignedVersionMismatch {
            signed: "0.1.0".into(),
            announced: "0.2.0".into()
        })
        .contains("nothing was installed"));
    }
}
