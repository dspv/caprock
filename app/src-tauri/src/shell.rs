//! The main window: native chrome, the daemon's dashboard or the bundled
//! fallback page, links to the system browser and downloads through a save
//! dialog. Then the monitor that follows the daemon and moves the window
//! between the two pages.

use crate::discovery;
use crate::supervisor::{State, Supervisor};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::webview::{DownloadEvent, NewWindowResponse};
use tauri::{AppHandle, Manager, Runtime, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

pub const MAIN: &str = "main";

/// The main window has finished loading a page at least once.
static MAIN_LOADED: AtomicBool = AtomicBool::new(false);

/// Pages the main window has finished loading, for the load watch.
static LOADS: AtomicU64 = AtomicU64::new(0);

/// Whether the last page the shell asked the main window for finished
/// loading (recover.rs).
static WATCH: Mutex<crate::recover::LoadWatch> = Mutex::new(crate::recover::LoadWatch::new());

/// The shell is about to ask the main window for a page: it must finish
/// loading within the watch's grace, or the monitor asks again.
pub fn expect_load() {
    WATCH
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .asked(Instant::now(), LOADS.load(Ordering::Relaxed));
}

/// Whether the page the shell asked for is overdue (`LoadWatch::overdue`):
/// the retry's number and the grace that ran out.
fn load_overdue() -> Option<(u32, Duration)> {
    let mut w = WATCH.lock().unwrap_or_else(|e| e.into_inner());
    let grace = w.grace();
    w.overdue(Instant::now(), LOADS.load(Ordering::Relaxed))
        .then(|| (w.tries(), grace))
}

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
        // The first click on a window that is not in front reaches the page
        // (macOS; the other systems already do). Without it macOS spends
        // that click on bringing the window forward, and a tab's × in the
        // title-bar strip took two clicks. Dragging is untouched: the strip's
        // `data-tauri-drag-region` still moves the window on press-and-drag.
        .accept_first_mouse(true)
        // A hidden or covered window still hears the live socket, or a
        // notification would wait for the app to come forward (WP-09).
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
        .initialization_script(INIT_SCRIPT)
        .on_navigation(move |url| allow_navigation(&opener, &sup, url))
        .on_new_window(move |url, _| {
            open_link(&opener2, &url);
            NewWindowResponse::Deny
        })
        .on_download(save_download)
        .on_page_load(move |w, p| {
            if !matches!(p.event(), tauri::webview::PageLoadEvent::Finished) {
                // A new dashboard page (a reload, a daemon swap, the
                // fallback page) starts with no browser tab's page over it
                // (browser.rs, ADR-075): hidden, never closed here.
                crate::browser::hide_all(w.app_handle());
                return;
            }
            #[cfg(all(feature = "snapshot", target_os = "macos"))]
            crate::snapshot::loaded(p.url());
            MAIN_LOADED.store(true, Ordering::Relaxed);
            LOADS.fetch_add(1, Ordering::Relaxed);
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
    listen_for_drops(&w);
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

/// Hands a native drop on the window's dashboard to the page.
///
/// A drop arrives as the window's event while the dashboard is the window's
/// own content (WindowEvent::DragDrop), and as the webview's when it is a
/// child of the window (WebviewEvent::DragDrop, as with the `unstable`
/// feature 0.123.0 turned on for a Page tab, since removed). Only one of the
/// two ever fires; both are heard, through the one `on_drop`, so neither
/// build drops a file on the floor, which 0.123.0 did. main.rs's tests drive
/// `on_drop` and check both registrations.
pub fn listen_for_drops<R: tauri::Runtime>(w: &WebviewWindow<R>) {
    let from_window = w.clone();
    w.on_window_event(move |e| {
        if let tauri::WindowEvent::DragDrop(d) = e {
            on_drop(&from_window, d);
        }
    });
    let from_webview = w.clone();
    w.on_webview_event(move |e| {
        if let tauri::WebviewEvent::DragDrop(d) = e {
            on_drop(&from_webview, d);
        }
    });
}

/// One drag event on the main window, from either listener: a drop records
/// its paths (the only files the feedback form may read, capture.rs) and
/// hands them to the page (DROP_EVENT), which types them into the terminal
/// under the point or the one used last. A drag that enters, moves or
/// leaves is not ours.
///
/// This runs on the main thread, which also draws every window, so it does
/// no file I/O there. A drop from Finder (the common case) needs none: its
/// paths are handed over as they are, at once. Only a drop with a file in a
/// transient place (`keep_transient`) is copied, and that copy runs on a
/// worker thread, which then records the paths and evaluates the script
/// (Tauri queues `eval` to the main thread). With the Mac swapping, a disk
/// read or write on the main thread can stall for seconds, and the app with
/// it (a user's report against 0.147.0).
///
/// Nothing in it may panic: it runs inside AppKit's drag callback, where a
/// panic aborts the app whatever the build (0.141.0 and 0.147.0 aborted on
/// a drag, in wry's and tao's own handlers before this one, now patched:
/// `patched/`). Every path is passed on as it is — an iCloud file that is
/// not downloaded, a `.icloud` placeholder, a name in any script — and one
/// that is not UTF-8 is recorded but not typed. A panic here all the same
/// is caught where the build unwinds (debug, tests) and logged.
pub fn on_drop<R: tauri::Runtime>(w: &WebviewWindow<R>, e: &tauri::DragDropEvent) {
    let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| handle_drop(w, e)));
    if caught.is_err() {
        if let Some(dir) = discovery::data_dir() {
            crate::applog::line(&dir, "a drop's handler panicked; the drop was skipped");
        }
    }
}

/// `on_drop`'s body.
fn handle_drop<R: tauri::Runtime>(w: &WebviewWindow<R>, e: &tauri::DragDropEvent) {
    let tauri::DragDropEvent::Drop { paths, position } = e else {
        return;
    };
    let scale = w.scale_factor().unwrap_or(1.0);
    let at = (position.x, position.y);
    if !paths.iter().any(|p| is_transient(p)) {
        deliver_drop(w, paths, at, scale);
        return;
    }
    let paste = discovery::data_dir().map(|d| d.join("paste"));
    let w = w.clone();
    let paths = paths.clone();
    // One worker at a time, so two quick drops still land in their order.
    static ORDER: std::sync::Mutex<()> = std::sync::Mutex::new(());
    thread::spawn(move || {
        let _turn = ORDER.lock().unwrap_or_else(|e| e.into_inner());
        let paths: Vec<PathBuf> = paths
            .iter()
            .map(|p| match &paste {
                Some(dir) => keep_transient(p, dir),
                None => p.clone(),
            })
            .collect();
        deliver_drop(&w, &paths, at, scale);
    });
}

/// Records a drop's paths and hands them to the page.
fn deliver_drop<R: tauri::Runtime>(
    w: &WebviewWindow<R>,
    paths: &[PathBuf],
    at: (f64, f64),
    scale: f64,
) {
    if let Some(d) = w.try_state::<crate::capture::Dropped>() {
        d.set(paths);
    }
    if let Some(js) = drop_script(paths, at, scale) {
        let _ = w.eval(js);
    }
}

/// Whether a dropped path is in one of macOS's temporary hand-over places
/// (`.../TemporaryItems/...`). Decided from the path alone, without touching
/// the disk, so the main thread may ask it.
pub fn is_transient(p: &std::path::Path) -> bool {
    p.components().any(|c| c.as_os_str() == "TemporaryItems")
}

/// A file macOS hands over from a temporary place — the screenshot
/// thumbnail's `…/TemporaryItems/NSIRD_screencaptureui_…/`, an image dragged
/// out of another app — is readable only by the app it was dropped on, and
/// only until it moves. Claude, under the daemon, gets "operation not
/// permitted". Such a file is copied into Caprock's paste directory, where
/// the session may read (`--add-dir`), and the copy's path is typed; any
/// other path, or a copy that fails, is typed as it is.
pub fn keep_transient(p: &std::path::Path, paste_dir: &std::path::Path) -> PathBuf {
    if !is_transient(p) || !p.is_file() {
        return p.to_path_buf();
    }
    let Some(name) = p.file_name() else {
        return p.to_path_buf();
    };
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = paste_dir.join(format!("drop-{stamp}"));
    let copy = dir.join(name);
    match std::fs::create_dir_all(&dir).and_then(|_| std::fs::copy(p, &copy)) {
        Ok(_) => copy,
        Err(_) => p.to_path_buf(),
    }
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

/// The main window's and the Mail window's navigation rule: main-frame
/// navigation stays on this daemon or the fallback page; anything else,
/// another local port included, is a link the user meant for the browser,
/// opened there and refused here.
pub fn allow_navigation<R: Runtime>(app: &AppHandle<R>, sup: &Supervisor, url: &Url) -> bool {
    let port = sup.runtime().map(|rt| rt.port);
    if (port.is_some() && is_daemon(url, port)) || is_local(url) || url.scheme() == "about" {
        return true;
    }
    open_link(app, url);
    false
}

/// An http(s) or mailto link in the system browser or mail app; any other
/// scheme is dropped.
pub fn open_link<R: Runtime>(app: &AppHandle<R>, url: &Url) {
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
pub fn save_download<R: Runtime>(webview: tauri::Webview<R>, event: DownloadEvent<'_>) -> bool {
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
        // The window's first page is one the shell asked for, too.
        expect_load();
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
            // On macOS a Homebrew daemon moves onto the app's own; on every
            // OS the app's own is replaced when the bundle carries another
            // (ADR-040).
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
            if let State::Connected { port, .. } = &state {
                #[cfg(target_os = "macos")]
                crate::popover::ensure(&app, *port);
                crate::mail::follow(&app, *port);
            }
            was_connected = connected;
            let main = app.get_webview_window(MAIN);
            if let Some(w) = &main {
                follow(w, &sup, &state, &mut resume);
                if let State::Connected { port, .. } = &state {
                    retry_overdue_load(w, &sup, *port);
                }
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
            expect_load();
            let _ = w.reload();
        }
    }
    #[cfg(target_os = "macos")]
    crate::popover::reload(app, port);
    crate::mail::reload(app, port);
}

/// View → Reload (Cmd+R): the main window loads its page again. On the
/// fallback page with a daemon connected, the monitor moves it on as usual.
/// Only the macOS menu has it; F5 elsewhere is the page's own.
#[cfg(target_os = "macos")]
pub fn reload_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN) {
        expect_load();
        let _ = w.reload();
    }
}

/// A page the shell asked for (the launch's, a move to the dashboard, a
/// reload) never finished loading while the daemon answers: a navigation cut
/// off before anything arrived fires no event, and the window would keep an
/// address on the daemon and draw nothing. Load it again, from the daemon:
/// its route when the address is the daemon's, else the workspace.
fn retry_overdue_load(w: &WebviewWindow, sup: &Supervisor, port: u16) {
    let Some((retry, grace)) = load_overdue() else {
        return;
    };
    let url = w
        .url()
        .ok()
        .filter(|u| is_daemon(u, Some(port)))
        .unwrap_or_else(|| dashboard_url(port));
    crate::applog::line(
        &sup.data_dir,
        &format!(
            "main window: no page finished loading within {} s; loading {} again (retry {retry})",
            grace.as_secs(),
            log_url(&url)
        ),
    );
    let _ = w.navigate(url);
}

/// An address for the app's log: scheme, host, port and path; never the
/// query or the route, which may name a session.
pub fn log_url(u: &Url) -> String {
    let mut s = format!("{}://{}", u.scheme(), u.host_str().unwrap_or(""));
    if let Some(p) = u.port() {
        s.push_str(&format!(":{p}"));
    }
    s.push_str(u.path());
    s
}

fn follow(w: &WebviewWindow, sup: &Arc<Supervisor>, state: &State, resume: &mut Option<Url>) {
    let Ok(current) = w.url() else { return };
    match state {
        State::Connected { port, .. } => {
            if let Some(url) = page_for(&current, resume.take(), *port) {
                if !is_daemon(&current, None) {
                    crate::applog::line(
                        &sup.data_dir,
                        &format!(
                            "main window: the daemon answers on port {port}; back to the dashboard"
                        ),
                    );
                }
                expect_load();
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
            let why = if matches!(state, State::Stopped) {
                "gone"
            } else {
                "too old"
            };
            crate::applog::line(
                &sup.data_dir,
                &format!(
                    "main window: the daemon is {why}; showing the app's own page until it is back"
                ),
            );
            *resume = Some(current);
            expect_load();
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
    fn the_log_names_where_a_page_was_but_never_the_route() {
        assert_eq!(
            log_url(&url("http://127.0.0.1:4173/?app=1#/session/abc")),
            "http://127.0.0.1:4173/"
        );
        assert!(log_url(&fallback_url()).ends_with("/index.html"));
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

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "caprock-drop-{tag}-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn a_screenshot_thumbnail_is_copied_where_the_session_can_read_it() {
        let root = scratch("thumb");
        let tmp = root.join("TemporaryItems").join("NSIRD_screencaptureui_x");
        std::fs::create_dir_all(&tmp).unwrap();
        let shot = tmp.join("Screenshot 1.png");
        std::fs::write(&shot, b"png").unwrap();
        let paste = root.join("paste");
        let got = keep_transient(&shot, &paste);
        assert!(got.starts_with(&paste), "{got:?}");
        assert_eq!(got.file_name(), shot.file_name());
        assert_eq!(std::fs::read(&got).unwrap(), b"png");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_ordinary_file_or_folder_is_typed_where_it_is() {
        let root = scratch("plain");
        let f = root.join("notes.md");
        std::fs::write(&f, b"x").unwrap();
        let paste = root.join("paste");
        assert_eq!(keep_transient(&f, &paste), f);
        let folder = root.join("TemporaryItems");
        std::fs::create_dir_all(&folder).unwrap();
        assert_eq!(keep_transient(&folder, &paste), folder);
        assert!(!paste.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn only_a_temporary_hand_over_place_is_transient() {
        assert!(is_transient(std::path::Path::new(
            "/var/folders/x/T/TemporaryItems/NSIRD_screencaptureui_1/Screenshot.png"
        )));
        assert!(!is_transient(std::path::Path::new(
            "/Users/a/Desktop/Screenshot.png"
        )));
        assert!(!is_transient(std::path::Path::new(
            "/Users/a/TemporaryItemsNot/x.png"
        )));
    }

    // A drop froze the app on a Mac that was swapping (0.147.0): the drop
    // handler runs on the main thread, which draws every window. A Finder
    // drop must touch no file there, and a transient copy happens only on
    // the worker thread.
    #[test]
    fn a_drop_does_no_file_io_on_the_main_thread() {
        let src = include_str!("shell.rs").replace("\r\n", "\n");
        let body = src
            .split("fn handle_drop<")
            .nth(1)
            .and_then(|r| r.split("\n}\n").next())
            .expect("handle_drop");
        let code: String = body
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        let (main, worker) = code
            .split_once("thread::spawn(")
            .expect("the copy runs on a worker thread");
        for io in [
            "keep_transient(",
            "std::fs",
            "is_file(",
            "metadata(",
            "exists(",
        ] {
            assert!(!main.contains(io), "{io} on the main thread: {main}");
        }
        assert!(worker.contains("keep_transient("), "{worker}");
    }

    // The paths a user drags, by the kinds that break drop handlers: names
    // in other scripts and emoji (a byte slice there panics), iCloud Drive
    // and its not-downloaded placeholders (0.141.0 and 0.147.0 aborted on
    // one), and spaces. Each is typed exactly as it is.
    fn odd_paths() -> Vec<PathBuf> {
        [
            "/Users/a/Desktop/\u{3b5}\u{3b9}\u{3ba}\u{3cc}\u{3bd}\u{3b1} \u{3c3}\u{3c7}\u{3ad}\u{3b4}\u{3b9}\u{3bf}.png",
            "/Users/a/Desktop/\u{1f600} notes \u{1f4c4}.md",
            "/Users/a/Desktop/\u{65e5}\u{672c}\u{8a9e}\u{306e}\u{30d5}\u{30a1}\u{30a4}\u{30eb}.txt",
            "/Users/a/Library/Mobile Documents/com~apple~CloudDocs/Desktop/linkly r2 token",
            "/Users/a/Library/Mobile Documents/com~apple~CloudDocs/Desktop/.linkly r2 token.icloud",
            "/Users/a/Desktop/caf\u{e9} r\u{e9}sum\u{e9}.pdf",
        ]
        .iter()
        .map(PathBuf::from)
        .collect()
    }

    #[test]
    fn every_odd_name_and_icloud_path_is_typed_as_it_is() {
        let paths = odd_paths();
        let d = detail(&drop_script(&paths, (3.0, 4.0), 2.0).unwrap());
        let want: Vec<&str> = paths.iter().map(|p| p.to_str().unwrap()).collect();
        assert_eq!(d["paths"], serde_json::json!(want));
        for p in &paths {
            assert!(!is_transient(p), "{}", p.display());
            // Not transient: handed back untouched, with no disk access.
            assert_eq!(&keep_transient(p, std::path::Path::new("/nonexistent")), p);
        }
    }

    #[test]
    fn an_empty_drop_and_a_missing_transient_file_are_no_trouble() {
        assert!(drop_script(&[], (0.0, 0.0), 0.0).is_none());
        // A hand-over file that is already gone is typed as it is: not
        // copied, and no panic.
        let gone =
            PathBuf::from("/private/var/folders/x/T/TemporaryItems/NSIRD_x/\u{1f600} gone.png");
        let paste = scratch("gone");
        assert_eq!(keep_transient(&gone, &paste), gone);
        let _ = std::fs::remove_dir_all(&paste);
    }

    // The abort itself was in wry's and tao's macOS drag handlers, which
    // unwrapped the pasteboard's file names. The app builds patched copies
    // (patched/, [patch.crates-io] in Cargo.toml). A crate bump that copies a
    // new release in without the patch fails here, not on a user's drag.
    #[test]
    fn the_patched_drag_handlers_never_unwrap() {
        let toml = include_str!("../Cargo.toml");
        assert!(toml.contains("wry = { path = \"patched/wry\" }"));
        assert!(toml.contains("tao = { path = \"patched/tao\" }"));
        let wry = include_str!("../patched/wry/src/wkwebview/drag_drop.rs").replace("\r\n", "\n");
        let tao = include_str!("../patched/tao/src/platform_impl/macos/window_delegate.rs")
            .replace("\r\n", "\n");
        let code = |s: &str| -> String {
            s.lines()
                .filter(|l| !l.trim_start().starts_with("//"))
                .collect::<Vec<_>>()
                .join("\n")
        };
        let body = |src: &str, f: &str| -> String {
            src.split(f)
                .nth(1)
                .and_then(|r| r.split("\n}\n").next())
                .map(code)
                .unwrap_or_else(|| panic!("{f}"))
        };
        assert!(wry.contains("CAPROCK PATCH") && tao.contains("CAPROCK PATCH"));
        let wry_paths = body(&wry, "fn collect_paths");
        assert!(!wry_paths.contains("unwrap()"), "{wry_paths}");
        assert!(wry_paths.contains("is_null()"), "{wry_paths}");
        for f in [
            "fn dragged_paths",
            "extern \"C\" fn dragging_entered",
            "extern \"C\" fn perform_drag_operation",
        ] {
            let b = body(&tao, f);
            assert!(!b.contains("unwrap()"), "{f}: {b}");
            assert!(!b.contains("cast_unchecked"), "{f}: {b}");
        }
    }
}
