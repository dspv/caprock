//! Mail in a window of its own, never as a tab inside Caprock's workspace
//! (owner, 2026-10-15). The page asks in order:
//!
//! 1. `open_mail_app`: on macOS, the installed Caprock Mail preview
//!    (`app/mail-mac`, bundle id `dev.caprock.mail.preview`) in /Applications
//!    or ~/Applications is launched or brought forward. Elsewhere, or with no
//!    such app, it answers false.
//! 2. `open_mail_window`: a second native window of this app, "Caprock Mail",
//!    on the daemon's `/?mail=1` (Mail alone, `ui/src/screens/mail/MailApp.tsx`),
//!    focused when it is already open.
//!
//! Only when neither answers does the page fall back to its Mail tab.

use crate::commands::Sup;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU16, Ordering};
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, Runtime, Url, WebviewUrl, WebviewWindowBuilder};

/// The Mail window's label (capabilities/mail.json).
pub const MAIL: &str = "mail";

/// The page the Mail window loads from the daemon (`ui/src/lib/appmode.ts`).
pub const ROUTE: &str = "/?mail=1";

/// The Mac preview's bundle id and bundle name (app/mail-mac/Info.plist).
pub const BUNDLE_ID: &str = "dev.caprock.mail.preview";
pub const BUNDLE_NAME: &str = "Caprock Mail.app";

/// The daemon port the Mail window was last pointed at. Remembered rather
/// than read back with `url()`, which wry unwraps on a page whose first load
/// never committed (popover.rs has the same rule).
static PORT: AtomicU16 = AtomicU16::new(0);

pub fn url(port: u16) -> Url {
    format!("http://127.0.0.1:{port}{ROUTE}")
        .parse()
        .expect("valid Mail URL")
}

/// Where the Mac preview may be installed, in the order looked at.
pub fn candidates(home: Option<&Path>) -> Vec<PathBuf> {
    let mut out = vec![PathBuf::from("/Applications").join(BUNDLE_NAME)];
    if let Some(h) = home {
        out.push(h.join("Applications").join(BUNDLE_NAME));
    }
    out
}

/// The first candidate that is the preview: a bundle whose Info.plist names
/// its bundle id (XML or binary, the id is stored as plain bytes either way).
/// Another app that happens to share the name is not launched.
pub fn installed(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates.iter().find_map(|app| {
        let plist = std::fs::read(app.join("Contents").join("Info.plist")).ok()?;
        let id = BUNDLE_ID.as_bytes();
        plist
            .windows(id.len())
            .any(|w| w == id)
            .then(|| app.clone())
    })
}

/// Launch or bring forward the installed Caprock Mail preview. True when it
/// was handed to the system; false on another OS, with no preview installed,
/// or when `open` failed. Off the main thread: `open` waits on LaunchServices.
#[tauri::command]
pub async fn open_mail_app() -> bool {
    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(|| {
            let Some(app) = installed(&candidates(dirs::home_dir().as_deref())) else {
                return false;
            };
            std::process::Command::new("/usr/bin/open")
                .arg(&app)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .is_ok_and(|s| s.success())
        })
        .await
        .unwrap_or(false)
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

/// Show the Mail window, creating it on the running daemon's `/?mail=1`
/// when there is none. False with no daemon to load it from or when the
/// window could not be made; the page then opens its Mail tab. Async, so
/// the window is built off the IPC thread (a window made from a synchronous
/// command deadlocks on Windows).
#[tauri::command]
pub async fn open_mail_window<R: Runtime>(
    app: AppHandle<R>,
    sup: tauri::State<'_, Sup>,
) -> Result<bool, ()> {
    if let Some(w) = app.get_webview_window(MAIL) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(true);
    }
    let Some(port) = sup.runtime().map(|rt| rt.port) else {
        return Ok(false);
    };
    PORT.store(port, Ordering::Relaxed);
    let guard_sup = sup.inner().clone();
    let opener = app.clone();
    let opener2 = app.clone();
    let built = WebviewWindowBuilder::new(&app, MAIL, WebviewUrl::External(url(port)))
        .title("Caprock Mail")
        .inner_size(1100.0, 720.0)
        .min_inner_size(640.0, 420.0)
        .focused(true)
        // The same rule as the main window: the daemon's own pages stay,
        // every other link opens in the system browser (shell.rs).
        .on_navigation(move |u| crate::shell::allow_navigation(&opener, &guard_sup, u))
        .on_new_window(move |u, _| {
            crate::shell::open_link(&opener2, &u);
            NewWindowResponse::Deny
        })
        .on_download(crate::shell::save_download)
        .build();
    match built {
        Ok(w) => {
            let _ = w.set_focus();
            Ok(true)
        }
        Err(e) => {
            eprintln!("caprock: no Mail window: {e}");
            Ok(false)
        }
    }
}

/// Called from the monitor while connected: a daemon that moved to another
/// port takes the Mail window with it.
pub fn follow<R: Runtime>(app: &AppHandle<R>, port: u16) {
    let Some(w) = app.get_webview_window(MAIL) else {
        return;
    };
    if PORT.swap(port, Ordering::Relaxed) != port {
        let _ = w.navigate(url(port));
    }
}

/// After the shell replaced the daemon on `port`, the Mail window reloads
/// from it, as the main window and the popover do.
pub fn reload<R: Runtime>(app: &AppHandle<R>, port: u16) {
    if PORT.load(Ordering::Relaxed) != port {
        return;
    }
    if let Some(w) = app.get_webview_window(MAIL) {
        let _ = w.reload();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "caprock-mailapp-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn bundle(root: &Path, id: &str) -> PathBuf {
        let app = root.join(BUNDLE_NAME);
        std::fs::create_dir_all(app.join("Contents")).unwrap();
        std::fs::write(
            app.join("Contents").join("Info.plist"),
            format!(
                "<plist><dict><key>CFBundleIdentifier</key><string>{id}</string></dict></plist>"
            ),
        )
        .unwrap();
        app
    }

    #[test]
    fn the_mail_window_loads_mail_alone_from_the_daemon() {
        assert_eq!(url(4173).as_str(), "http://127.0.0.1:4173/?mail=1");
        assert!(crate::shell::is_daemon(&url(4173), Some(4173)));
    }

    #[test]
    fn the_preview_is_looked_for_in_applications_then_the_home_applications() {
        let c = candidates(Some(Path::new("/Users/me")));
        assert_eq!(
            c,
            vec![
                PathBuf::from("/Applications/Caprock Mail.app"),
                PathBuf::from("/Users/me/Applications/Caprock Mail.app"),
            ]
        );
        assert_eq!(candidates(None).len(), 1);
    }

    #[test]
    fn only_a_bundle_with_the_preview_id_is_launched() {
        let root = scratch("id");
        let other = root.join("a");
        let ours = root.join("b");
        let wrong = bundle(&other, "com.example.mail");
        let right = bundle(&ours, BUNDLE_ID);
        let missing = root.join("none").join(BUNDLE_NAME);
        assert_eq!(installed(&[missing.clone(), wrong.clone()]), None);
        assert_eq!(installed(&[missing, wrong, right.clone()]), Some(right));
        let _ = std::fs::remove_dir_all(&root);
    }
}
