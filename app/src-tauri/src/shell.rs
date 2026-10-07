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
  // Reload: Cmd+R is the macOS menu's View -> Reload. Elsewhere there is no
  // menu, and Ctrl+R belongs to the shell in a terminal, so it is F5 — unless
  // a focused terminal took the key for its program (xterm cancels it).
  if (!mac) addEventListener('keydown', (e) => {
    if (e.key !== 'F5' || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    e.preventDefault();
    location.reload();
  });
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

/// The first page the main window loads, from the launch's first look at the
/// daemon: its dashboard when a compatible one answers and stays, else the
/// bundled fallback page (`None`). `replacing` is the launch's decision to put
/// the app's own daemon in place of the one that answers (ADR-040): that
/// daemon is about to stop, so its page would be the old UI for the rest of
/// the run. The window waits on the fallback page ("Updating the daemon")
/// and the monitor moves it to the dashboard once the new daemon answers.
pub fn first_page(state: &State, replacing: bool) -> Option<Url> {
    match state {
        State::Connected { port, .. } if !replacing => Some(dashboard_url(*port)),
        _ => None,
    }
}

/// Where the main window goes when a compatible daemon on `port` answers and
/// the window is not on its origin: the page it left for the fallback page,
/// else the same route on a daemon that moved to another port, else the
/// workspace. `None` when it is already there.
pub fn page_for(current: &Url, resume: Option<Url>, port: u16) -> Option<Url> {
    if is_daemon(current, Some(port)) {
        return None;
    }
    let mut url = resume
        .or_else(|| is_daemon(current, None).then(|| current.clone()))
        .unwrap_or_else(|| dashboard_url(port));
    let _ = url.set_port(Some(port));
    Some(url)
}

/// Whether the main window reloads once a daemon the shell replaced under its
/// page answers on `port`: only a page from that daemon's origin. A page on
/// another port is moved by `page_for`, and the fallback page has nothing
/// stale to reload.
pub fn reloads_after_swap(current: &Url, port: u16) -> bool {
    is_daemon(current, Some(port))
}

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
        // The shell replaced the daemon under a page it had served.
        let mut swapped_under_page = false;
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
            let mut state = sup.observe(found, absent_for);
            // macOS: a Homebrew daemon moves onto the app's own, and the
            // app's own is replaced when the bundle carries another (ADR-040).
            // A launch decides this before the first page loads (main.rs), so
            // this is the late case: a daemon that came up after launch. Not
            // before the window's first page has committed: a WebView whose
            // first load is cut off by the switch has no URL, and wry unwraps
            // it on the main thread when asked.
            if matches!(state, State::Connected { .. } | State::TooOld { .. })
                && MAIN_LOADED.load(Ordering::Relaxed)
                && sup.should_adopt(|| sup.bundled_version())
            {
                sup.spawn_adopt();
                // The swap has claimed the supervisor ("Updating the daemon"):
                // follow that, not the daemon that is about to stop, or the
                // window would load the old UI from it now.
                state = sup.state();
                // A page already loaded from that daemon is its UI; it is
                // reloaded once the new daemon answers.
                swapped_under_page = app
                    .get_webview_window(MAIN)
                    .and_then(|w| w.url().ok())
                    .is_some_and(|u| is_daemon(&u, None));
            }
            if swapped_under_page {
                if let State::Connected { port, .. } = &state {
                    swapped_under_page = false;
                    reload_after_swap(&app, *port);
                }
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

/// The new daemon answers after a swap under a loaded page: the main window
/// and the popover reload from it, keeping their routes (a reload keeps the
/// URL, hash included). A terminal's half-typed line lives in its pty-host,
/// not in the page, so nothing typed is lost.
fn reload_after_swap(app: &AppHandle, port: u16) {
    if let Some(w) = app.get_webview_window(MAIN) {
        if w.url().is_ok_and(|u| reloads_after_swap(&u, port)) {
            let _ = w.reload();
        }
    }
    #[cfg(target_os = "macos")]
    crate::popover::reload(app, port);
}

/// View → Reload (Cmd+R): the main window loads its page again. On the
/// fallback page with a daemon connected, the monitor moves it on as usual.
pub fn reload_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.reload();
    }
}

fn follow(w: &WebviewWindow, sup: &Arc<Supervisor>, state: &State, resume: &mut Option<Url>) {
    let Ok(current) = w.url() else { return };
    match state {
        State::Connected { port, .. } => {
            if let Some(url) = page_for(&current, resume.take(), *port) {
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

    fn connected(port: u16) -> State {
        State::Connected {
            port,
            version: "0.78.1".into(),
            api_level: 1,
            ours: true,
        }
    }

    #[test]
    fn a_launch_that_replaces_the_daemon_loads_no_page_from_it() {
        // 0.78.2's bug: the window loaded 0.78.1's UI two seconds before the
        // app replaced that daemon, and kept it.
        assert_eq!(first_page(&connected(4173), true), None);
        assert_eq!(
            first_page(&connected(4173), false),
            Some(dashboard_url(4173))
        );
        assert_eq!(first_page(&State::Searching, false), None);
        assert_eq!(
            first_page(
                &State::Starting {
                    step: "Updating the daemon".into()
                },
                false
            ),
            None
        );
    }

    fn url(s: &str) -> Url {
        s.parse().unwrap()
    }

    #[test]
    fn a_connected_daemon_takes_the_window_back_to_where_it_was() {
        let fallback = fallback_url();
        // From the fallback page: the page it left, on the daemon's port now.
        let left = url("http://127.0.0.1:4173/?app=1#/session/abc");
        assert_eq!(
            page_for(&fallback, Some(left), 4180),
            Some(url("http://127.0.0.1:4180/?app=1#/session/abc"))
        );
        // Nothing to go back to: the workspace.
        assert_eq!(page_for(&fallback, None, 4173), Some(dashboard_url(4173)));
        // A daemon that moved port keeps the route.
        assert_eq!(
            page_for(&url("http://127.0.0.1:4173/?app=1#/cost"), None, 4174),
            Some(url("http://127.0.0.1:4174/?app=1#/cost"))
        );
        // Already there: nothing to do.
        assert_eq!(
            page_for(&url("http://127.0.0.1:4173/?app=1#/cost"), None, 4173),
            None
        );
    }

    #[test]
    fn only_a_page_from_the_replaced_daemon_reloads_after_a_swap() {
        assert!(reloads_after_swap(
            &url("http://127.0.0.1:4173/?app=1#/app"),
            4173
        ));
        assert!(!reloads_after_swap(
            &url("http://127.0.0.1:4173/?app=1#/app"),
            4174
        ));
        assert!(!reloads_after_swap(&fallback_url(), 4173));
    }

    #[test]
    fn f5_reloads_outside_macos_unless_a_terminal_took_it() {
        // Ctrl+R is the shell's reverse search in a terminal: never taken.
        assert!(INIT_SCRIPT.contains("e.key !== 'F5' || e.defaultPrevented"));
        assert!(!INIT_SCRIPT.contains("'r'"));
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
