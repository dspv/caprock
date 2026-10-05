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

use std::path::{Path, PathBuf};
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
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(200));
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
        let req = dir.join("request");
        let Ok(name) = std::fs::read_to_string(&req) else {
            continue;
        };
        let _ = std::fs::remove_file(&req);
        let out = dir.join(format!("{}.png", name.trim()));
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Some(w) = handle.get_webview_window(crate::shell::MAIN) {
                let result = capture(&w, &out);
                let _ = std::fs::write(out.with_extension("txt"), format!("{result:?}"));
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

#[allow(deprecated)]
fn capture(w: &tauri::WebviewWindow, out: &Path) -> Result<(), String> {
    use objc2::AnyThread;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSWindow};
    use objc2_core_foundation::{CGPoint, CGRect, CGSize};
    use objc2_core_graphics::{CGWindowImageOption, CGWindowListCreateImage, CGWindowListOption};
    use objc2_foundation::NSDictionary;

    let ptr = w.ns_window().map_err(|e| e.to_string())?;
    // SAFETY: Tauri hands out the window's NSWindow, alive for this call on
    // the main thread.
    let window: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
    let id = window.windowNumber() as u32;
    let null = CGRect::new(
        CGPoint::new(f64::INFINITY, f64::INFINITY),
        CGSize::new(0.0, 0.0),
    );
    let image = CGWindowListCreateImage(
        null,
        CGWindowListOption::OptionIncludingWindow,
        id,
        CGWindowImageOption::BoundsIgnoreFraming,
    )
    .ok_or("CGWindowListCreateImage returned nothing")?;
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
