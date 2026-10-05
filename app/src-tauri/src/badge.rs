//! The dock (macOS) or taskbar badge (F10): the number of sessions waiting
//! on you, gone when none. Windows has no count on the taskbar, so it shows
//! a dot overlay; Linux shows the count where the desktop supports the Unity
//! launcher API.

use crate::shell::MAIN;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Runtime};

/// The count last shown, so an unchanged frame touches nothing.
#[derive(Default)]
pub struct Badge(Mutex<Option<u32>>);

pub fn set<R: Runtime>(app: &AppHandle<R>, count: u32) {
    {
        let state = app.state::<Badge>();
        let mut last = state.0.lock().unwrap_or_else(|e| e.into_inner());
        if *last == Some(count) {
            return;
        }
        *last = Some(count);
    }
    #[cfg(all(feature = "snapshot", target_os = "macos"))]
    crate::snapshot::record("badge.txt", count.to_string());
    let Some(w) = app.get_webview_window(MAIN) else {
        return;
    };
    #[cfg(not(target_os = "windows"))]
    let _ = w.set_badge_count((count > 0).then_some(i64::from(count)));
    #[cfg(target_os = "windows")]
    let _ = w.set_overlay_icon((count > 0).then(dot));
}

/// A 16 px red dot for the Windows taskbar overlay.
#[cfg(any(target_os = "windows", test))]
fn dot() -> tauri::image::Image<'static> {
    const N: u32 = 16;
    let rgba = (0..N * N)
        .flat_map(|i| {
            let (x, y) = ((i % N) as f32 - 7.5, (i / N) as f32 - 7.5);
            let inside = x * x + y * y <= 7.5 * 7.5;
            if inside {
                [0xd9, 0x3f, 0x2f, 0xff]
            } else {
                [0, 0, 0, 0]
            }
        })
        .collect();
    tauri::image::Image::new_owned(rgba, N, N)
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_overlay_dot_is_a_filled_circle() {
        let d = super::dot();
        assert_eq!((d.width(), d.height()), (16, 16));
        let px = |x: usize, y: usize| d.rgba()[(y * 16 + x) * 4 + 3];
        assert_eq!(px(8, 8), 0xff, "centre opaque");
        assert_eq!(px(0, 0), 0, "corner clear");
    }
}
