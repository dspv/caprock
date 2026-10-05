//! The main window: native chrome, the daemon's dashboard or the bundled
//! fallback page, links to the system browser and downloads through a save
//! dialog. Then the monitor that follows the daemon and moves the window
//! between the two pages.

use crate::discovery;
use crate::supervisor::{State, Supervisor};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::webview::{DownloadEvent, NewWindowResponse};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

pub const MAIN: &str = "main";

/// The dashboard's app entry point: the UI turns its app layout on for the
/// `?app=1` flag and opens the workspace at `#/app` (`ui/src/lib/appmode.ts`).
pub const APP_ROUTE: &str = "/?app=1#/app";

/// Runs in every page before its scripts. Tells the page it is in the shell
/// and how much room the macOS traffic lights take; the page sets
/// `data-caprock-chrome` on `<html>` once it lays out around them itself.
/// Until then a thin draggable strip keeps the window movable and clear of
/// the buttons.
const INIT_SCRIPT: &str = r#"(() => {
  const mac = navigator.platform.startsWith('Mac');
  window.__CAPROCK_SHELL__ = Object.freeze({ app: true, platform: mac ? 'macos' : 'other',
    titlebarInset: mac ? 28 : 0, trafficLightsInset: mac ? 78 : 0 });
  if (!mac || location.protocol !== 'http:') return;
  const de = document.documentElement;
  de.dataset.caprockShell = 'tauri';
  de.style.setProperty('--caprock-titlebar-inset', '28px');
  de.style.setProperty('--caprock-traffic-lights-inset', '78px');
  addEventListener('DOMContentLoaded', () => {
    if (de.hasAttribute('data-caprock-chrome')) return;
    const style = document.createElement('style');
    style.textContent = 'html[data-caprock-shell]:not([data-caprock-chrome]) body{padding-top:28px;box-sizing:border-box}' +
      '#caprock-drag{position:fixed;top:0;left:0;right:0;height:28px;z-index:2147483647}' +
      'html[data-caprock-chrome] #caprock-drag{display:none}';
    const strip = document.createElement('div');
    strip.id = 'caprock-drag';
    strip.setAttribute('data-tauri-drag-region', '');
    document.head.append(style);
    document.body.append(strip);
  });
})();"#;

pub fn dashboard_url(port: u16) -> Url {
    format!("http://127.0.0.1:{port}{APP_ROUTE}")
        .parse()
        .expect("valid dashboard URL")
}

/// Whether `url` is the daemon's own origin: loopback http on its port.
pub fn is_daemon(url: &Url, port: Option<u16>) -> bool {
    url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && port.is_none_or(|p| url.port() == Some(p))
}

/// Whether `url` is the shell's own bundled page.
fn is_local(url: &Url) -> bool {
    matches!(url.scheme(), "tauri") || url.host_str() == Some("tauri.localhost")
}

pub fn build(
    app: &AppHandle,
    sup: Arc<Supervisor>,
    start: WebviewUrl,
    focus: bool,
) -> tauri::Result<WebviewWindow> {
    let opener = app.clone();
    let opener2 = app.clone();
    let shown = Arc::new(AtomicBool::new(false));
    let b = WebviewWindowBuilder::new(app, MAIN, start)
        .title("Caprock")
        .inner_size(1280.0, 800.0)
        .min_inner_size(720.0, 480.0)
        .visible(false)
        .focused(focus)
        .initialization_script(INIT_SCRIPT)
        .on_navigation(move |url| {
            // Main-frame navigation stays on this daemon or the fallback page;
            // anything else, another local port included, is a link the user
            // meant for the browser.
            let port = sup.runtime().map(|rt| rt.port);
            if (port.is_some() && is_daemon(url, port)) || is_local(url) || url.scheme() == "about"
            {
                return true;
            }
            open_external(&opener, url);
            false
        })
        .on_new_window(move |url, _| {
            open_external(&opener2, &url);
            NewWindowResponse::Deny
        })
        .on_download(save_download)
        .on_page_load(move |w, p| {
            if !matches!(p.event(), tauri::webview::PageLoadEvent::Finished) {
                return;
            }
            #[cfg(all(feature = "snapshot", target_os = "macos"))]
            crate::snapshot::loaded(p.url());
            // Shown once, when the first page is ready (no white flash); a
            // later reload must not pull the window forward.
            if !shown.swap(true, Ordering::Relaxed) {
                let _ = w.show();
            }
        });
    #[cfg(target_os = "macos")]
    let b = {
        use tauri::utils::config::WindowEffectsConfig;
        use tauri::window::Effect;
        b.title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .traffic_light_position(tauri::LogicalPosition::new(14.0, 18.0))
            .transparent(true)
            .effects(WindowEffectsConfig {
                effects: vec![Effect::Sidebar],
                ..Default::default()
            })
    };
    let w = b.build()?;
    // If the first page is slow, show the window anyway rather than nothing.
    let late = w.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(1200));
        if !late.is_visible().unwrap_or(true) {
            let _ = late.show();
        }
    });
    Ok(w)
}

fn open_external(app: &AppHandle, url: &Url) {
    if matches!(url.scheme(), "http" | "https" | "mailto") {
        let _ = app.opener().open_url(url.as_str(), None::<&str>);
    }
}

/// Downloads in flight: the temporary file each one is written to, by URL.
#[derive(Default)]
pub struct Downloads(Mutex<HashMap<String, PathBuf>>);

/// Every download asks where to save, with the page's suggested name. The
/// WebView writes it to a temporary file first and the dialog opens when it
/// is complete: the download callback runs on the main thread, where a
/// blocking dialog would deadlock the very event loop it needs.
fn save_download(webview: tauri::Webview, event: DownloadEvent<'_>) -> bool {
    let app = webview.app_handle();
    let downloads = app.state::<Downloads>();
    match event {
        DownloadEvent::Requested { url, destination } => {
            let name = destination
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .filter(|n| !n.is_empty())
                .unwrap_or_else(|| "download".into());
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let dir = std::env::temp_dir()
                .join("caprock-downloads")
                .join(stamp.to_string());
            if std::fs::create_dir_all(&dir).is_err() {
                return false;
            }
            let temp = dir.join(name);
            *destination = temp.clone();
            downloads
                .0
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(url.to_string(), temp);
            true
        }
        DownloadEvent::Finished { url, success, .. } => {
            let Some(temp) = downloads
                .0
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(url.as_str())
            else {
                return true;
            };
            if !success {
                let _ = std::fs::remove_file(&temp);
                return true;
            }
            let name = temp
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            let mut dialog = app.dialog().file().set_file_name(&name);
            if let Some(dir) = dirs::download_dir() {
                dialog = dialog.set_directory(dir);
            }
            dialog.save_file(move |chosen| {
                if let Some(dest) = chosen.and_then(|p| p.into_path().ok()) {
                    if std::fs::rename(&temp, &dest).is_err() {
                        let _ = std::fs::copy(&temp, &dest);
                    }
                }
                let _ = std::fs::remove_file(&temp);
                if let Some(dir) = temp.parent() {
                    let _ = std::fs::remove_dir(dir);
                }
            });
            true
        }
        _ => true,
    }
}

/// Follows the daemon for the life of the app: polls twice a second, moves
/// the window to the dashboard when a compatible daemon answers (again, or
/// on a new port) and to the fallback page when it has stopped and the page
/// is not showing that itself.
pub fn monitor(app: AppHandle, sup: Arc<Supervisor>) {
    thread::spawn(move || {
        let mut absent_since: Option<Instant> = None;
        let mut resume: Option<Url> = None;
        loop {
            let found = discovery::find(&sup.data_dir);
            let absent_for = match found {
                discovery::Found::Absent => absent_since.get_or_insert_with(Instant::now).elapsed(),
                _ => {
                    absent_since = None;
                    Duration::ZERO
                }
            };
            let state = sup.observe(found, absent_for);
            if let Some(w) = app.get_webview_window(MAIN) {
                follow(&w, &sup, &state, &mut resume);
            }
            let fast = matches!(state, State::Searching | State::Starting { .. });
            thread::sleep(Duration::from_millis(if fast { 250 } else { 500 }));
        }
    });
}

fn follow(w: &WebviewWindow, sup: &Arc<Supervisor>, state: &State, resume: &mut Option<Url>) {
    let Ok(current) = w.url() else { return };
    match state {
        State::Connected { port, .. } => {
            if !is_daemon(&current, Some(*port)) {
                let mut url = resume.take().unwrap_or_else(|| dashboard_url(*port));
                let _ = url.set_port(Some(*port));
                let _ = w.navigate(url);
            }
        }
        State::Starting { .. } if sup.take_autostart() => {
            let background = sup.settings().is_none_or(|s| s.background);
            sup.spawn_start(background);
        }
        State::Stopped | State::TooOld { .. } if is_daemon(&current, None) => {
            if matches!(state, State::Stopped) && sup.page_polls() {
                return; // the page shows its own banner and reconnects
            }
            *resume = Some(current);
            let _ = w.navigate(fallback_url());
        }
        _ => {}
    }
}

/// The bundled fallback page, under the app's own scheme.
pub fn fallback_url() -> Url {
    let base = if cfg!(windows) {
        "http://tauri.localhost/"
    } else {
        "tauri://localhost/"
    };
    format!("{base}index.html")
        .parse()
        .expect("valid fallback URL")
}
