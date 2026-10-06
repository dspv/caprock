//! The menu bar popover (macOS): a left click on the menu bar icon shows a
//! small borderless window under it with the daemon's `#/tray` page — what
//! needs you, what is running, the plan windows, today's spend. The window is
//! created hidden as soon as a daemon answers, so a click shows a page that
//! is already painted. It hides when it loses focus. A right click keeps the
//! native menu (tray.rs).
//!
//! It is a non-activating panel (`panel` below): showing it, typing Escape in
//! it or clicking a row never activates Caprock, so the main window stays
//! where it is and the app you were in keeps its focus. Only "Open" brings
//! Caprock forward, on purpose.

use crate::hotkey;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{
    AppHandle, LogicalSize, Manager, PhysicalPosition, Rect, Runtime, Url, WebviewUrl,
    WebviewWindowBuilder,
};

pub const POPOVER: &str = "tray";
/// The page the popover loads from the daemon (`ui/src/lib/appmode.ts`).
pub const ROUTE: &str = "/?app=1#/tray";
const WIDTH: f64 = 380.0;
const MIN_HEIGHT: f64 = 140.0;
const MAX_HEIGHT: f64 = 640.0;
/// A click on the icon blurs the popover before the click arrives; a click
/// this soon after a blur closed it, so it must not reopen it.
const REOPEN_GUARD: Duration = Duration::from_millis(300);

/// When the popover last hid because it lost focus.
#[derive(Default)]
pub struct Popover(Mutex<Option<Instant>>);

pub fn url(port: u16) -> Url {
    format!("http://127.0.0.1:{port}{ROUTE}")
        .parse()
        .expect("valid popover URL")
}

/// The daemon port the popover was last pointed at.
static PORT: AtomicU16 = AtomicU16::new(0);

/// The popover's height for its content, within bounds whatever the page asks.
pub fn fit_height(h: f64) -> f64 {
    if h.is_finite() {
        h.clamp(MIN_HEIGHT, MAX_HEIGHT)
    } else {
        MAX_HEIGHT
    }
}

/// Creates the hidden popover for the daemon on `port`, or points it there
/// when the daemon moved. Called from the monitor while connected.
pub fn ensure<R: Runtime>(app: &AppHandle<R>, port: u16) {
    // The port is remembered rather than read back with `url()`: a popover
    // whose first load never committed (the daemon stopped while it loaded,
    // as when the app moves a Homebrew daemon onto its own, ADR-040) has no
    // URL, and wry unwraps it on the main thread — the app aborted.
    if let Some(w) = app.get_webview_window(POPOVER) {
        if PORT.swap(port, Ordering::Relaxed) != port {
            let _ = w.navigate(url(port));
        }
        return;
    }
    PORT.store(port, Ordering::Relaxed);
    let b = WebviewWindowBuilder::new(app, POPOVER, WebviewUrl::External(url(port)))
        .title("Caprock")
        .inner_size(WIDTH, 420.0)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible_on_all_workspaces(true)
        .visible(false)
        .focused(false)
        // Only the daemon's own page: a link goes to the main window's
        // browser handling, never into the popover.
        .on_navigation(move |u| crate::shell::is_daemon(u, Some(port)));
    #[cfg(target_os = "macos")]
    let b = {
        use tauri::utils::config::WindowEffectsConfig;
        use tauri::window::{Effect, EffectState};
        b.effects(WindowEffectsConfig {
            effects: vec![Effect::Popover],
            state: Some(EffectState::Active),
            radius: Some(12.0),
            ..Default::default()
        })
    };
    let Ok(w) = b.build() else { return };
    #[cfg(target_os = "macos")]
    {
        let panel = w.clone();
        let _ = app.run_on_main_thread(move || {
            if let Err(e) = panel::convert(&panel) {
                eprintln!("caprock: the popover stays an ordinary window: {e}");
            }
        });
    }
    let handle = app.clone();
    w.on_window_event(move |e| {
        if let tauri::WindowEvent::Focused(false) = e {
            *handle
                .state::<Popover>()
                .0
                .lock()
                .unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());
            hide(&handle);
        }
    });
}

/// A left click on the menu bar icon: show the popover under it, or hide it.
/// With no popover yet (no daemon has answered), the main window comes up.
pub fn toggle<R: Runtime>(app: &AppHandle<R>, rect: Rect) {
    let Some(w) = app.get_webview_window(POPOVER) else {
        hotkey::show(app);
        return;
    };
    if w.is_visible().unwrap_or(false) {
        hide(app);
        return;
    }
    let blurred = *app
        .state::<Popover>()
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if blurred.is_some_and(|t| t.elapsed() < REOPEN_GUARD) {
        return;
    }
    let scale = w.scale_factor().unwrap_or(1.0);
    let icon = rect.position.to_physical::<f64>(scale);
    let size = rect.size.to_physical::<f64>(scale);
    let width = WIDTH * scale;
    let mut x = icon.x + size.width / 2.0 - width / 2.0;
    let y = icon.y + size.height + 4.0 * scale;
    // Kept on the icon's screen, clear of its edges.
    if let Ok(Some(m)) = w.monitor_from_point(icon.x, icon.y) {
        let (left, right) = (
            m.position().x as f64,
            (m.position().x + m.size().width as i32) as f64,
        );
        x = x.clamp(left + 8.0 * scale, (right - width - 8.0 * scale).max(left));
    }
    let _ = w.set_position(PhysicalPosition::new(x, y));
    let _ = w.eval("window.dispatchEvent(new Event('caprock:tray-shown'))");
    present(app, &w);
}

/// Shows the popover with the keyboard in its page. On macOS the panel
/// becomes key without activating the app; `show` and `set_focus` would
/// activate it and raise the main window with it.
fn present<R: Runtime>(app: &AppHandle<R>, w: &tauri::WebviewWindow<R>) {
    #[cfg(target_os = "macos")]
    if panel::present(w) {
        // The page's keys (Escape, arrows) need the web view as first responder.
        let _ = w.with_webview(|pw| panel::focus_view(pw.ns_window(), pw.inner()));
        return;
    }
    let _ = app;
    let _ = w.show();
    let _ = w.set_focus();
}

/// The popover as an `NSPanel` with the non-activating style, the way menu
/// bar apps (and the community `tauri-nspanel` crate) do it, without a crate:
/// the window Tauri built changes class to a panel subclass that may become
/// key. Tao's own window subclass adds `canBecomeKeyWindow` and a
/// drag-by-background `sendEvent:`; the first is answered here, the second
/// is not needed by a window that never moves.
#[cfg(target_os = "macos")]
pub mod panel {
    use objc2::runtime::{AnyClass, AnyObject, Bool, ClassBuilder, NSObjectProtocol, Sel};
    use objc2::{msg_send, sel, ClassType};
    use objc2_app_kit::{NSPanel, NSWindow, NSWindowCollectionBehavior, NSWindowStyleMask};
    use std::sync::OnceLock;

    extern "C-unwind" fn yes(_: &AnyObject, _: Sel) -> Bool {
        Bool::YES
    }

    extern "C-unwind" fn no(_: &AnyObject, _: Sel) -> Bool {
        Bool::NO
    }

    /// An `NSPanel` subclass with the same instance layout as Tao's window
    /// class (`TaoWindow`: `NSWindow` plus one `focusable` BOOL), so the
    /// object Tauri allocated can change class safely; objc2 checks that the
    /// sizes match.
    fn class() -> &'static AnyClass {
        static CLASS: OnceLock<&'static AnyClass> = OnceLock::new();
        CLASS.get_or_init(|| {
            let mut b = ClassBuilder::new(c"CaprockPopoverPanel", NSPanel::class())
                .expect("CaprockPopoverPanel is declared once");
            b.add_ivar::<Bool>(c"focusable");
            // SAFETY: both match the selectors' signature: () -> BOOL.
            unsafe {
                b.add_method(
                    sel!(canBecomeKeyWindow),
                    yes as extern "C-unwind" fn(_, _) -> _,
                );
                b.add_method(
                    sel!(canBecomeMainWindow),
                    no as extern "C-unwind" fn(_, _) -> _,
                );
            }
            b.register()
        })
    }

    fn window<R: tauri::Runtime>(w: &tauri::WebviewWindow<R>) -> Option<&NSWindow> {
        let ptr = w.ns_window().ok()?;
        // SAFETY: Tauri hands out the window's NSWindow, alive while the
        // Tauri window is; every caller is on the main thread.
        (!ptr.is_null()).then(|| unsafe { &*(ptr as *const NSWindow) })
    }

    /// Turns the popover's window into a non-activating panel. Main thread.
    pub fn convert<R: tauri::Runtime>(w: &tauri::WebviewWindow<R>) -> Result<(), String> {
        let win = window(w).ok_or("no NSWindow")?;
        let obj: &AnyObject = win.as_ref();
        if obj.class() != class() {
            // SAFETY: the panel class derives from NSPanel (an NSWindow that
            // adds no instance variables) and declares the one Tao's class
            // adds, so the object keeps its size and layout.
            unsafe { AnyObject::set_class(obj, class()) };
        }
        // SAFETY: the object is an NSPanel now.
        let panel: &NSPanel = unsafe { &*(win as *const NSWindow as *const NSPanel) };
        panel.setStyleMask(panel.styleMask() | NSWindowStyleMask::NonactivatingPanel);
        // The window server learns of the style only at creation; a window
        // given it later must be told so, or a click still activates the app.
        let prevents: Sel = sel!(_setPreventsActivation:);
        if panel.respondsToSelector(prevents) {
            // SAFETY: a private AppKit method taking a BOOL, asked for first.
            unsafe {
                let _: () = msg_send![panel, _setPreventsActivation: true];
            }
        }
        panel.setFloatingPanel(true);
        panel.setBecomesKeyOnlyIfNeeded(false);
        panel.setHidesOnDeactivate(false);
        panel.setCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::FullScreenAuxiliary
                | NSWindowCollectionBehavior::IgnoresCycle,
        );
        Ok(())
    }

    /// Whether the window is the non-activating panel.
    pub fn is_panel<R: tauri::Runtime>(w: &tauri::WebviewWindow<R>) -> bool {
        window(w).is_some_and(|win| {
            let obj: &AnyObject = win.as_ref();
            obj.class() == class()
                && win
                    .styleMask()
                    .contains(NSWindowStyleMask::NonactivatingPanel)
        })
    }

    /// Makes the web view the panel's first responder. Main thread.
    pub fn focus_view(win: *mut std::ffi::c_void, view: *mut std::ffi::c_void) {
        if win.is_null() || view.is_null() {
            return;
        }
        // SAFETY: both come from Tauri's own web view, alive in this callback,
        // which runs on the main thread.
        unsafe {
            let win = &*(win as *const NSWindow);
            let view = view as *mut AnyObject;
            let _: bool = msg_send![win, makeFirstResponder: view];
        }
    }

    /// Orders the panel in and makes it key without activating the app.
    /// False when it is not a panel (the caller falls back). Main thread.
    pub fn present<R: tauri::Runtime>(w: &tauri::WebviewWindow<R>) -> bool {
        if !is_panel(w) {
            return false;
        }
        let Some(win) = window(w) else { return false };
        win.orderFrontRegardless();
        win.makeKeyWindow();
        true
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn the_panel_class_is_a_key_capable_panel_laid_out_like_taos_window() {
            let c = class();
            assert_eq!(c.superclass(), Some(NSPanel::class()));
            // Laid out like Tao's window class, NSWindow plus one BOOL ivar,
            // asked of the runtime rather than written down: on macOS 26 the
            // BOOL fits in NSWindow's tail padding (520 bytes either way),
            // on 27 it adds a word.
            let tao = {
                let mut b = ClassBuilder::new(c"CaprockTaoLikeWindow", NSWindow::class())
                    .expect("declared once");
                b.add_ivar::<Bool>(c"focusable");
                b.register()
            };
            assert_eq!(
                NSPanel::class().instance_size(),
                NSWindow::class().instance_size()
            );
            assert_eq!(c.instance_size(), tao.instance_size());
            let ivar = c.instance_variable(c"focusable").expect("focusable");
            let want = tao.instance_variable(c"focusable").expect("focusable");
            assert_eq!(ivar.offset(), want.offset());
            assert!(c.instance_method(sel!(canBecomeKeyWindow)).is_some());
        }
    }
}

/// Hides the popover and tells its page, which stops asking the daemon.
pub fn hide<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window(POPOVER) {
        let _ = w.hide();
        let _ = w.eval("window.dispatchEvent(new Event('caprock:tray-hidden'))");
    }
}

/// From the popover's page: hide it and bring the main window up, on the
/// session when one is named.
#[tauri::command]
pub fn tray_open<R: Runtime>(session: Option<String>, app: AppHandle<R>) {
    hide(&app);
    match session.filter(|s| !s.is_empty()) {
        Some(s) => crate::tray::open_session(&app, &s),
        None => hotkey::show(&app),
    }
}

/// From the popover's page: hide it (Escape).
#[tauri::command]
pub fn tray_hide<R: Runtime>(app: AppHandle<R>) {
    hide(&app);
}

/// From the popover's page: the height its content needs.
#[tauri::command]
pub fn tray_fit<R: Runtime>(height: f64, app: AppHandle<R>) {
    if let Some(w) = app.get_webview_window(POPOVER) {
        let _ = w.set_size(LogicalSize::new(WIDTH, fit_height(height)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_popover_loads_the_tray_route_of_the_daemon() {
        assert_eq!(url(4391).as_str(), "http://127.0.0.1:4391/?app=1#/tray");
        assert!(crate::shell::is_daemon(&url(4391), Some(4391)));
    }

    #[test]
    fn a_page_cannot_size_the_popover_off_the_screen() {
        assert_eq!(fit_height(10.0), MIN_HEIGHT);
        assert_eq!(fit_height(5000.0), MAX_HEIGHT);
        assert_eq!(fit_height(f64::NAN), MAX_HEIGHT);
        assert_eq!(fit_height(300.0), 300.0);
    }
}
