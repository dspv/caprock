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

/// The main window has finished loading a page at least once.
static MAIN_LOADED: AtomicBool = AtomicBool::new(false);

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
        // A hidden or covered window still hears the live socket, or a
        // notification would wait for the app to come forward (WP-09).
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
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
            MAIN_LOADED.store(true, Ordering::Relaxed);
            // Shown once, when the first page is ready (no white flash); a
            // later reload must not pull the window forward.
            if !shown.swap(true, Ordering::Relaxed) {
                let _ = w.show();
            }
        });
    // `--features snapshot` only: bench/ (WP-16) runs its page hook before
    // the page's own scripts, from `$CAPROCK_APP_SNAPSHOT_DIR/init.js`.
    #[cfg(feature = "snapshot")]
    let b = match std::env::var_os("CAPROCK_APP_SNAPSHOT_DIR")
        .and_then(|d| std::fs::read_to_string(PathBuf::from(d).join("init.js")).ok())
    {
        Some(js) => b.initialization_script(js),
        None => b,
    };
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
    // The native drag-and-drop handler stays on (Tauri's default): a file
    // dropped from Finder, Explorer or a file manager arrives here with its
    // real path, which the terminal under the pointer types quoted — as a
    // terminal does — instead of the page uploading a copy of the bytes.
    // The cost is that the page sees no HTML5 drag events at all, so nothing
    // in it may rely on them (the tab strip reorders by pointer events).
    // .ai/21-app.md § Dropping a file.
    let w = b.build()?;
    let dropped = w.clone();
    w.on_window_event(move |e| {
        if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, position }) = e {
            let scale = dropped.scale_factor().unwrap_or(1.0);
            if let Some(js) = drop_script(paths, (position.x, position.y), scale) {
                let _ = dropped.eval(js);
            }
        }
    });
    // macOS: closing the window hides it; the app stays in the menu bar
    // with its hotkey and badge (Cmd+Q quits). Elsewhere closing quits, as
    // a tray may not be shown at all (GNOME without an indicator extension).
    #[cfg(target_os = "macos")]
    {
        let hidden = w.clone();
        w.on_window_event(move |e| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = e {
                api.prevent_close();
                let _ = hidden.hide();
            }
        });
    }
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

/// The event the page's terminals listen for (`ui/src/lib/xtermInput.ts`).
pub const DROP_EVENT: &str = "caprock:drop-paths";

/// The script that hands dropped files to the page: their paths and where
/// they landed, in CSS pixels. Wry reports the point in the webview's own
/// coordinates, which are points on macOS and Linux but device pixels on
/// Windows, so only Windows is divided by the scale factor. A path that is
/// not UTF-8 cannot be typed and is left out; `None` when nothing is left.
pub fn drop_script(paths: &[PathBuf], (x, y): (f64, f64), scale: f64) -> Option<String> {
    let paths: Vec<&str> = paths.iter().filter_map(|p| p.to_str()).collect();
    if paths.is_empty() {
        return None;
    }
    let scale = if cfg!(windows) && scale > 0.0 {
        scale
    } else {
        1.0
    };
    let detail = serde_json::json!({ "paths": paths, "x": x / scale, "y": y / scale });
    Some(format!(
        "window.dispatchEvent(new CustomEvent('{DROP_EVENT}', {{ detail: {detail} }}))"
    ))
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
        let mut was_connected = false;
        let mut last = discovery::Found::Absent;
        let mut full_at = Instant::now();
        loop {
            // `/v1/status` every FULL_CHECK; `/healthz` alone in between.
            let found = if full_at.elapsed() < FULL_CHECK {
                discovery::recheck(&sup.data_dir, &last)
            } else {
                full_at = Instant::now();
                discovery::find(&sup.data_dir)
            };
            last = found.clone();
            let absent_for = match found {
                discovery::Found::Absent => absent_since.get_or_insert_with(Instant::now).elapsed(),
                _ => {
                    absent_since = None;
                    Duration::ZERO
                }
            };
            let state = sup.observe(found, absent_for);
            // macOS: a Homebrew daemon moves onto the app's own (ADR-040).
            // Not before the window's first page has committed: a WebView
            // whose first load is cut off by the switch has no URL, and wry
            // unwraps it on the main thread when asked.
            if matches!(
                state,
                State::Connected { ours: false, .. } | State::TooOld { ours: false, .. }
            ) && MAIN_LOADED.load(Ordering::Relaxed)
                && sup.should_adopt(|| sup.bundled_version())
            {
                sup.spawn_adopt();
            }
            let connected = matches!(state, State::Connected { .. });
            if was_connected && !connected {
                crate::tray::daemon_gone(&app);
            }
            #[cfg(target_os = "macos")]
            if let State::Connected { port, .. } = &state {
                crate::popover::ensure(&app, *port);
            }
            was_connected = connected;
            let main = app.get_webview_window(MAIN);
            if let Some(w) = &main {
                follow(w, &sup, &state, &mut resume);
            }
            let fast = matches!(state, State::Searching | State::Starting { .. });
            let visible = || main.as_ref().is_none_or(|w| w.is_visible().unwrap_or(true));
            // A hidden window with a daemon in hand asks every 5 s, and at
            // once when it is shown again (WP-16: hidden CPU).
            let wait = if fast {
                Duration::from_millis(250)
            } else if connected && !visible() {
                HIDDEN_CHECK
            } else {
                Duration::from_millis(500)
            };
            if wait != HIDDEN_CHECK {
                thread::sleep(wait);
                continue;
            }
            // Hidden: look once a second whether it has been shown.
            let start = Instant::now();
            while start.elapsed() < wait && !visible() {
                thread::sleep(Duration::from_secs(1));
            }
        }
    });
}

/// How often the monitor asks `/v1/status` as well as `/healthz`.
const FULL_CHECK: Duration = Duration::from_secs(10);
/// How often the monitor asks while the window is hidden.
const HIDDEN_CHECK: Duration = Duration::from_secs(5);

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

#[cfg(test)]
mod tests {
    use super::*;

    fn detail(js: &str) -> serde_json::Value {
        let start = js.find("detail: ").expect("detail") + "detail: ".len();
        let end = js.rfind(" }))").expect("end");
        serde_json::from_str(&js[start..end]).expect("json")
    }

    #[test]
    fn a_drop_carries_every_path_in_order_and_where_it_landed() {
        let js = drop_script(
            &[
                PathBuf::from("/Users/me/My Notes.md"),
                PathBuf::from("/tmp/a\"b.png"),
            ],
            (120.0, 48.0),
            1.0,
        )
        .expect("script");
        assert!(js.starts_with("window.dispatchEvent(new CustomEvent('caprock:drop-paths'"));
        let d = detail(&js);
        assert_eq!(
            d["paths"],
            serde_json::json!(["/Users/me/My Notes.md", "/tmp/a\"b.png"])
        );
        assert_eq!(d["x"], 120.0);
        assert_eq!(d["y"], 48.0);
    }

    #[test]
    fn a_drop_with_nothing_typeable_sends_nothing() {
        assert!(drop_script(&[], (1.0, 1.0), 1.0).is_none());
    }

    #[test]
    fn only_windows_reports_the_point_in_device_pixels() {
        let d = detail(&drop_script(&[PathBuf::from("/x")], (200.0, 100.0), 2.0).unwrap());
        let want = if cfg!(windows) {
            (100.0, 50.0)
        } else {
            (200.0, 100.0)
        };
        assert_eq!((d["x"].as_f64().unwrap(), d["y"].as_f64().unwrap()), want);
    }

    #[cfg(unix)]
    #[test]
    fn a_path_that_is_not_utf8_is_left_out() {
        use std::ffi::OsStr;
        use std::os::unix::ffi::OsStrExt;
        let bad = PathBuf::from(OsStr::from_bytes(b"/tmp/\xff"));
        let d = detail(&drop_script(&[bad, PathBuf::from("/ok")], (0.0, 0.0), 1.0).unwrap());
        assert_eq!(d["paths"], serde_json::json!(["/ok"]));
    }
}
