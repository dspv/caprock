//! The commands a page may call. Which page may call which is decided by the
//! capabilities (`capabilities/*.json`): the daemon's origin gets
//! `daemon_status` and `open_external`; the bundled fallback page also gets
//! the ones that start, update or reconfigure the daemon.

use crate::supervisor::{State, Supervisor};
use std::sync::Arc;
use tauri::{AppHandle, Runtime, Url, Webview};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

pub type Sup = Arc<Supervisor>;

/// The supervisor's view of the daemon. A daemon page that polls this at
/// least every 2 s owns the "daemon stopped" state (shows its own banner);
/// otherwise the shell switches to the fallback page while the daemon is gone.
#[tauri::command]
pub fn daemon_status<R: Runtime>(webview: Webview<R>, sup: tauri::State<'_, Sup>) -> State {
    if webview
        .url()
        .is_ok_and(|u| u.scheme() == "http" && u.host_str() == Some("127.0.0.1"))
    {
        sup.touch_poll();
    }
    sup.state()
}

/// Start the daemon, as a login service when `background`; without it, the
/// way the app started it before (on by default, decision 7).
#[tauri::command]
pub fn start_daemon(background: Option<bool>, sup: tauri::State<'_, Sup>) {
    let background = background.unwrap_or_else(|| sup.settings().is_none_or(|s| s.background));
    sup.spawn_start(background);
}

/// Replace an outdated daemon this app installed with the bundled one.
#[tauri::command]
pub fn update_daemon(sup: tauri::State<'_, Sup>) {
    sup.spawn_update();
}

/// Turn the login service on or off.
#[tauri::command]
pub async fn set_background(on: bool, sup: tauri::State<'_, Sup>) -> Result<(), String> {
    let sup = sup.inner().clone();
    tauri::async_runtime::spawn_blocking(move || sup.set_background(on))
        .await
        .map_err(|e| e.to_string())?
}

/// Open a web or mail link in the system browser or mail app. Only http(s)
/// and mailto, as the window's own link handling (`shell.rs`): a page must
/// not be able to launch arbitrary URL schemes through the shell.
///
/// One app scheme besides: `tg:`, for the share sheet's *Send to someone in
/// Telegram* (`ShareActions.tsx`). It opens only when an app on this machine
/// says it handles `tg:`, and is refused otherwise, so the page falls back
/// to t.me rather than the system asking what to open it with. Async, so
/// the check and the launch never hold the window's thread.
#[tauri::command]
pub async fn open_external<R: Runtime>(url: String, app: AppHandle<R>) -> Result<(), String> {
    let parsed: Url = url.parse().map_err(|_| format!("not a URL: {url}"))?;
    match parsed.scheme() {
        "http" | "https" | "mailto" => app
            .opener()
            .open_url(parsed.as_str(), None::<&str>)
            .map_err(|e| e.to_string()),
        "tg" => tauri::async_runtime::spawn_blocking(move || open_app_link(parsed.as_str()))
            .await
            .map_err(|e| e.to_string())?,
        other => Err(format!("refused to open a {other} URL")),
    }
}

/// An app link, opened only where an app is registered for its scheme.
/// macOS: `open` exits non-zero when nothing handles the URL, and launches
/// the handler otherwise.
#[cfg(target_os = "macos")]
fn open_app_link(url: &str) -> Result<(), String> {
    let ok = std::process::Command::new("/usr/bin/open")
        .arg(url)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map_err(|e| e.to_string())?
        .success();
    if ok {
        Ok(())
    } else {
        Err("no app here opens this link".into())
    }
}

/// Windows: a scheme is handled when HKEY_CLASSES_ROOT has its key with a
/// shell command; then `explorer` opens it as a click would.
#[cfg(windows)]
fn open_app_link(url: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let scheme = url.split(':').next().unwrap_or_default();
    let registered = std::process::Command::new("reg")
        .args(["query", &format!("HKCR\\{scheme}\\shell\\open\\command")])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if !registered {
        return Err("no app here opens this link".into());
    }
    std::process::Command::new("explorer")
        .arg(url)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Linux: xdg-mime names the desktop entry for the scheme, or nothing.
#[cfg(all(unix, not(target_os = "macos")))]
fn open_app_link(url: &str) -> Result<(), String> {
    let scheme = url.split(':').next().unwrap_or_default();
    let handler = std::process::Command::new("xdg-mime")
        .args(["query", "default", &format!("x-scheme-handler/{scheme}")])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    if handler.is_empty() {
        return Err("no app here opens this link".into());
    }
    std::process::Command::new("xdg-open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// The system's folder chooser, for New project: the folder the person
/// picked, or None when they cancelled. It opens where `start` points when
/// that is a folder. Nothing is read or written: the page gets a path the
/// person chose, and the daemon checks it as it checks a typed one.
#[tauri::command]
pub async fn pick_folder<R: Runtime>(
    start: Option<String>,
    app: AppHandle<R>,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = app.dialog().file().set_title("Choose a project folder");
        if let Some(dir) = start.map(std::path::PathBuf::from).filter(|p| p.is_dir()) {
            dialog = dialog.set_directory(dir);
        }
        dialog
            .blocking_pick_folder()
            .and_then(|p| p.into_path().ok())
            .map(|p| p.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())
}

/// What the menu bar or tray shows (F08), computed by the page.
#[tauri::command]
pub fn set_tray<R: Runtime>(view: crate::tray::View, app: AppHandle<R>) -> Result<(), String> {
    crate::tray::set(&app, view).map_err(|e| e.to_string())
}

/// The dock or taskbar badge: sessions waiting on you (F10).
#[tauri::command]
pub fn set_badge<R: Runtime>(count: u32, app: AppHandle<R>) {
    crate::badge::set(&app, count);
}

/// The global hotkey as configured, and whether the OS took it (F09).
#[tauri::command]
pub fn hotkey_status(hk: tauri::State<'_, crate::hotkey::Hotkey>) -> crate::hotkey::Status {
    hk.status()
}

/// Replace the global hotkey; `null` turns it off. A shortcut the OS
/// refuses is an error and the previous one stays.
#[tauri::command]
pub fn register_hotkey<R: Runtime>(
    accelerator: Option<String>,
    app: AppHandle<R>,
) -> Result<crate::hotkey::Status, String> {
    crate::hotkey::change(&app, accelerator)
}

/// The app's updater: its version, whether this install can update itself,
/// the first-launch question, and where a check or install stands (F20).
#[tauri::command]
pub fn app_update_status<R: Runtime>(app: AppHandle<R>) -> crate::updater::Info {
    crate::updater::info(&app)
}

/// Fetch `latest.json` once: the "Check for Updates" action.
#[tauri::command]
pub async fn app_update_check<R: Runtime>(app: AppHandle<R>) -> Result<crate::updater::Info, ()> {
    Ok(crate::updater::check(app).await)
}

/// Download and verify, and hold it for a later install: Update
/// automatically, once the daemon's release check found a newer version.
#[tauri::command]
pub async fn app_update_download<R: Runtime>(
    app: AppHandle<R>,
) -> Result<crate::updater::Info, ()> {
    Ok(crate::updater::download(app).await)
}

/// Download, verify, install and restart. Returns only when it did not.
#[tauri::command]
pub async fn app_update_install<R: Runtime>(app: AppHandle<R>) -> Result<crate::updater::Info, ()> {
    Ok(crate::updater::install(app).await)
}

/// The first-launch question was answered (either way).
#[tauri::command]
pub fn app_update_asked(updates: tauri::State<'_, crate::updater::Updates>) -> Result<(), String> {
    updates.mark_asked().map_err(|e| e.to_string())
}

/// Scale the page as the browser's own zoom does (⌘+ / ⌘- in the app), so
/// the terminal re-measures its cells rather than being stretched by CSS.
/// Clamped to what the Appearance setting offers.
#[tauri::command]
pub fn set_zoom<R: Runtime>(scale: f64, webview: Webview<R>) -> Result<(), String> {
    if !scale.is_finite() {
        return Err("not a scale".into());
    }
    webview
        .set_zoom(scale.clamp(0.8, 1.6))
        .map_err(|e| e.to_string())
}

/// One line in the app's own log (`<data dir>/app.log`, applog.rs) from the
/// dashboard: its crash screen, or its watchdog for a page that never
/// started. On this machine only; at most `PAGE_LINES_PER_RUN` lines a run.
#[tauri::command]
pub fn app_log<R: Runtime>(webview: Webview<R>, message: String, sup: tauri::State<'_, Sup>) {
    crate::applog::page_line(&sup.data_dir, webview.label(), &message);
}
