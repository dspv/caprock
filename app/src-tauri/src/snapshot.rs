//! Development aid behind the `snapshot` feature (never in a shipped build):
//! captures the app's own window, title bar included, to PNG when asked.
//! Write a name to `$CAPROCK_APP_SNAPSHOT_DIR/request` and the window lands
//! in `$CAPROCK_APP_SNAPSHOT_DIR/<name>.png`. A process may capture its own
//! windows without the screen-recording permission an outside tool needs.
//! A script written to `$CAPROCK_APP_SNAPSHOT_DIR/eval` runs in the page, so
//! a check can press a button without synthesizing input on a shared desktop.
//! `show` or `hide` written to `$CAPROCK_APP_SNAPSHOT_DIR/popover` toggles the
//! menu bar popover as a click on the icon would, and `popover.json` then
//! says whether the app became active and which window is key; `hide-app`
//! hides the app and shows it again without activating it, so the check
//! starts from an inactive app whose windows are behind the one in front.
//! The capture includes the in-app browser's page windows (`browser-*`,
//! child windows of the main one) composited over it, and writes every
//! window's place to `<name>.json`, so a check sees a page that draws past
//! its tab or past the window. `W H` written to `size` resizes the main
//! window (logical px), `W H X Y` moves it too; a script written to `page-eval` runs in every page
//! window and each answer is appended to `page-eval.out`.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// Writes what the tray and badge last showed to `<dir>/<name>`, so a check
/// can read them without opening the menu.
pub fn record(name: &str, body: String) {
    if let Some(dir) = std::env::var_os("CAPROCK_APP_SNAPSHOT_DIR") {
        let _ = std::fs::write(Path::new(&dir).join(name), body);
    }
}

pub fn watch(app: AppHandle) {
    let Some(dir) = std::env::var_os("CAPROCK_APP_SNAPSHOT_DIR").map(PathBuf::from) else {
        return;
    };
    // Under bench/ (an init script), a slower watch: its own wakeups would
    // otherwise be part of the idle CPU rows it measures.
    let bench = dir.join("init.js").exists();
    if bench {
        keep_painting(&app);
    }
    let every = Duration::from_millis(if bench { 1000 } else { 200 });
    let mut painting = std::collections::HashSet::new();
    std::thread::spawn(move || loop {
        std::thread::sleep(every);
        if let Ok(js) = std::fs::read_to_string(dir.join("eval")) {
            let _ = std::fs::remove_file(dir.join("eval"));
            if let Some(w) = app.get_webview_window(crate::shell::MAIN) {
                let _ = w.eval(js);
            }
        }
        if let Ok(what) = std::fs::read_to_string(dir.join("popover")) {
            let _ = std::fs::remove_file(dir.join("popover"));
            if what.trim() == "hide-app" {
                // Hidden, then shown again without activation: inactive,
                // its windows behind the app in front.
                let _ = app.run_on_main_thread(|| {
                    if let Some(mtm) = objc2::MainThreadMarker::new() {
                        objc2_app_kit::NSApplication::sharedApplication(mtm).hide(None);
                    }
                });
                std::thread::sleep(Duration::from_millis(500));
                let _ = app.run_on_main_thread(|| {
                    if let Some(mtm) = objc2::MainThreadMarker::new() {
                        objc2_app_kit::NSApplication::sharedApplication(mtm)
                            .unhideWithoutActivation();
                    }
                });
            } else {
                popover(&app, what.trim() == "show", dir.join("popover.json"));
            }
        }
        if let Ok(size) = std::fs::read_to_string(dir.join("size")) {
            let _ = std::fs::remove_file(dir.join("size"));
            let n: Vec<f64> = size
                .split_whitespace()
                .filter_map(|v| v.parse().ok())
                .collect();
            if let (Some(&w), Some(&h)) = (n.first(), n.get(1)) {
                if let Some(m) = app.get_webview_window(crate::shell::MAIN) {
                    let _ = m.set_size(tauri::LogicalSize::new(w, h));
                    if let (Some(&x), Some(&y)) = (n.get(2), n.get(3)) {
                        let _ = m.set_position(tauri::LogicalPosition::new(x, y));
                    }
                }
            }
        }
        if let Ok(js) = std::fs::read_to_string(dir.join("page-eval")) {
            let _ = std::fs::remove_file(dir.join("page-eval"));
            for (label, w) in app.webview_windows() {
                if !label.starts_with(crate::browser::PREFIX) {
                    continue;
                }
                let out = dir.join("page-eval.out");
                let _ = w.eval_with_callback(js.clone(), move |raw| {
                    use std::io::Write;
                    if let Ok(mut f) = std::fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(&out)
                    {
                        let _ = writeln!(f, "{label} {raw}");
                    }
                });
            }
        }
        // Under bench/, a page window keeps painting while off screen too.
        if bench {
            for (label, w) in app.webview_windows() {
                if label.starts_with(crate::browser::PREFIX) && painting.insert(label) {
                    occlusion_detection(&w, false);
                }
            }
        }
        // bench/ (WP-16): the window hidden, for the hidden-window CPU row,
        // with WebKit's occlusion detection back on as in a shipped build.
        if std::fs::remove_file(dir.join("hide")).is_ok() {
            if let Some(w) = app.get_webview_window(crate::shell::MAIN) {
                occlusion_detection(&w, true);
                end_activity();
                let _ = w.hide();
            }
        }
        let req = dir.join("request");
        let Ok(name) = std::fs::read_to_string(&req) else {
            continue;
        };
        let _ = std::fs::remove_file(&req);
        let out = dir.join(format!("{}.png", name.trim()));
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Some(w) = handle.get_webview_window(crate::shell::MAIN) {
                let pages: Vec<tauri::WebviewWindow> = handle
                    .webview_windows()
                    .into_iter()
                    .filter(|(l, p)| {
                        l.starts_with(crate::browser::PREFIX) && p.is_visible().unwrap_or(false)
                    })
                    .map(|(_, p)| p)
                    .collect();
                let result = capture(&w, &pages, &out);
                let _ = std::fs::write(out.with_extension("txt"), format!("{result:?}"));
                let _ = std::fs::write(out.with_extension("json"), places(&handle).to_string());
            }
        });
    });
}

/// Shows or hides the popover on the main thread, then records the state.
fn popover(app: &AppHandle, show: bool, out: PathBuf) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if show {
            let rect = tauri::Rect {
                position: tauri::LogicalPosition::new(900.0, 0.0).into(),
                size: tauri::LogicalSize::new(24.0, 24.0).into(),
            };
            crate::popover::toggle(&handle, rect);
        } else {
            crate::popover::hide(&handle);
        }
    });
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(800));
        let h2 = handle.clone();
        let _ = handle.run_on_main_thread(move || {
            use objc2::MainThreadMarker;
            use objc2_app_kit::NSApplication;
            let Some(mtm) = MainThreadMarker::new() else {
                return;
            };
            let ns = NSApplication::sharedApplication(mtm);
            let key = |label: &str| {
                h2.get_webview_window(label)
                    .and_then(|w| w.ns_window().ok())
                    .map(|p| unsafe { &*(p as *const objc2_app_kit::NSWindow) })
                    .map(|w| (w.isVisible(), w.isKeyWindow()))
            };
            let pop = h2.get_webview_window(crate::popover::POPOVER);
            let body = serde_json::json!({
                "app_active": ns.isActive(),
                "popover_is_panel": pop.as_ref().is_some_and(crate::popover::panel::is_panel),
                "popover_visible_key": key(crate::popover::POPOVER),
                "main_visible_key": key(crate::shell::MAIN),
            });
            let _ = std::fs::write(&out, body.to_string());
        });
    });
}

/// bench/ (WP-16): a window that is off screen or covered keeps painting on
/// time, as Chrome's `--disable-backgrounding-occluded-windows` does, and App
/// Nap stays off. WebKit SPI, as in the Tauri spike's bench.
fn keep_painting(app: &AppHandle) {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    if let Some(w) = app.get_webview_window(crate::shell::MAIN) {
        occlusion_detection(&w, false);
    }
    // NSActivityUserInitiatedAllowingIdleSystemSleep | NSActivityLatencyCritical
    const OPTIONS: u64 = 0x00EF_FFFF | 0xFF_0000_0000;
    let reason = objc2_foundation::NSString::from_str("Caprock benchmark");
    // SAFETY: NSProcessInfo's documented API; the token is retained for the
    // life of the process, which keeps the activity open.
    unsafe {
        let info: *mut AnyObject = msg_send![class!(NSProcessInfo), processInfo];
        let token: *mut AnyObject =
            msg_send![info, beginActivityWithOptions: OPTIONS, reason: &*reason];
        let _: *mut AnyObject = msg_send![token, retain];
        ACTIVITY.store(token as usize, Ordering::Relaxed);
    }
}

/// The activity `keep_painting` began; ended before the hidden-window row,
/// so App Nap treats the app as a shipped build.
static ACTIVITY: AtomicUsize = AtomicUsize::new(0);

fn end_activity() {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    let token = ACTIVITY.swap(0, Ordering::Relaxed) as *mut AnyObject;
    if token.is_null() {
        return;
    }
    // SAFETY: the token began in keep_painting and is still retained.
    unsafe {
        let info: *mut AnyObject = msg_send![class!(NSProcessInfo), processInfo];
        let _: () = msg_send![info, endActivity: token];
    }
}

/// WebKit SPI `_setWindowOcclusionDetectionEnabled:`, when this WebKit has it.
fn occlusion_detection(w: &tauri::WebviewWindow, enabled: bool) {
    use objc2::runtime::AnyObject;
    use objc2::{msg_send, sel};
    let _ = w.with_webview(move |pw| {
        let v = pw.inner() as *mut AnyObject;
        // SAFETY: Tauri hands out its live WKWebView on the main thread; the
        // selector is checked before it is sent.
        unsafe {
            let ok: bool =
                msg_send![v, respondsToSelector: sel!(_setWindowOcclusionDetectionEnabled:)];
            if ok {
                let _: () = msg_send![v, _setWindowOcclusionDetectionEnabled: enabled];
            }
        }
    });
}

/// Every window of the app, logical px on screen: whether it is visible,
/// its scale, and its outer and inner frames as `[x, y, width, height]`.
fn places(app: &AppHandle) -> serde_json::Value {
    let mut all = serde_json::Map::new();
    for (label, w) in app.webview_windows() {
        let scale = w.scale_factor().unwrap_or(1.0);
        let pos = w.outer_position().map(|p| p.to_logical::<f64>(scale));
        let size = w.outer_size().map(|s| s.to_logical::<f64>(scale));
        let inner = w.inner_position().map(|p| p.to_logical::<f64>(scale));
        let inner_size = w.inner_size().map(|s| s.to_logical::<f64>(scale));
        if let (Ok(p), Ok(s), Ok(ip), Ok(is)) = (pos, size, inner, inner_size) {
            all.insert(
                label,
                serde_json::json!({
                    "visible": w.is_visible().unwrap_or(false),
                    "scale": scale,
                    "outer": [p.x, p.y, s.width, s.height],
                    "inner": [ip.x, ip.y, is.width, is.height],
                }),
            );
        }
    }
    serde_json::Value::Object(all)
}

/// The main window with the page windows shown over it, composited by the
/// window server in the order given (front first), over the union of their
/// frames: a page past the window's edge shows past it.
#[allow(deprecated)]
fn capture(
    w: &tauri::WebviewWindow,
    pages: &[tauri::WebviewWindow],
    out: &Path,
) -> Result<(), String> {
    use objc2::AnyThread;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSWindow};
    use objc2_core_foundation::{CFArray, CGPoint, CGRect, CGSize};
    use objc2_core_graphics::{CGWindowImageOption, CGWindowListCreateImageFromArray};
    use objc2_foundation::NSDictionary;

    let number = |w: &tauri::WebviewWindow| -> Result<usize, String> {
        let ptr = w.ns_window().map_err(|e| e.to_string())?;
        // SAFETY: Tauri hands out the window's NSWindow, alive for this call
        // on the main thread.
        let window: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
        Ok(window.windowNumber() as usize)
    };
    let mut ids: Vec<*const std::ffi::c_void> = Vec::new();
    for p in pages {
        ids.push(number(p)? as *const std::ffi::c_void);
    }
    ids.push(number(w)? as *const std::ffi::c_void);
    // SAFETY: CGWindowIDs stored as pointer-sized values with no callbacks,
    // which is what CGWindowListCreateImageFromArray reads.
    let array =
        unsafe { CFArray::new(None, ids.as_mut_ptr(), ids.len() as isize, std::ptr::null()) }
            .ok_or("CFArrayCreate returned nothing")?;
    let null = CGRect::new(
        CGPoint::new(f64::INFINITY, f64::INFINITY),
        CGSize::new(0.0, 0.0),
    );
    // SAFETY: the array holds window ids, as above.
    let image = unsafe {
        CGWindowListCreateImageFromArray(null, &array, CGWindowImageOption::BoundsIgnoreFraming)
    }
    .ok_or("CGWindowListCreateImageFromArray returned nothing")?;
    let rep = NSBitmapImageRep::initWithCGImage(NSBitmapImageRep::alloc(), &image);
    // SAFETY: an empty properties dictionary is valid for PNG.
    let png = unsafe {
        rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new())
    }
    .ok_or("PNG encoding failed")?;
    std::fs::write(out, png.to_vec()).map_err(|e| e.to_string())
}

/// Appends `<epoch ms> <url>` to `$CAPROCK_APP_SNAPSHOT_DIR/loads.txt` when a
/// page finishes loading, for timing a cold start from outside.
pub fn loaded(url: &tauri::Url) {
    use std::io::Write;
    let Some(dir) = std::env::var_os("CAPROCK_APP_SNAPSHOT_DIR").map(PathBuf::from) else {
        return;
    };
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("loads.txt"))
    {
        let _ = writeln!(f, "{ms} {url}");
    }
}
