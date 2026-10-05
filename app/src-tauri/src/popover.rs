//! The menu bar popover (macOS): a left click on the menu bar icon shows a
//! small borderless window under it with the daemon's `#/tray` page — what
//! needs you, what is running, the plan windows, today's spend. The window is
//! created hidden as soon as a daemon answers, so a click shows a page that
//! is already painted. It hides when it loses focus. A right click keeps the
//! native menu (tray.rs).

use crate::hotkey;
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
    if let Some(w) = app.get_webview_window(POPOVER) {
        if w.url().is_ok_and(|u| u.port() != Some(port)) {
            let _ = w.navigate(url(port));
        }
        return;
    }
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
    let _ = w.show();
    let _ = w.set_focus();
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
