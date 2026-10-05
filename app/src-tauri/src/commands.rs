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

/// Open a web link in the system browser. Only http(s): a page must not be
/// able to launch arbitrary URL schemes through the shell.
#[tauri::command]
pub fn open_external<R: Runtime>(url: String, app: AppHandle<R>) -> Result<(), String> {
    let parsed: Url = url.parse().map_err(|_| format!("not a URL: {url}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!("refused to open a {} URL", parsed.scheme()));
    }
    app.opener()
        .open_url(parsed.as_str(), None::<&str>)
        .map_err(|e| e.to_string())
}
