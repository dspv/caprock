//! The commands a page may call. Which page may call which is decided by the
//! capabilities (`capabilities/*.json`): the daemon's origin gets
//! `daemon_status` and `open_external`; the bundled fallback page also gets
//! the ones that start, update or reconfigure the daemon.

use crate::supervisor::{State, Supervisor};
use std::sync::Arc;
use tauri::{AppHandle, Runtime, Url, Webview};
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
#[tauri::command]
pub fn open_external<R: Runtime>(url: String, app: AppHandle<R>) -> Result<(), String> {
    let parsed: Url = url.parse().map_err(|_| format!("not a URL: {url}"))?;
    if !matches!(parsed.scheme(), "http" | "https" | "mailto") {
        return Err(format!("refused to open a {} URL", parsed.scheme()));
    }
    app.opener()
        .open_url(parsed.as_str(), None::<&str>)
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
