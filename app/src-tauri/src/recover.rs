//! A window that went blank comes back by itself (.ai/21-app.md § A blank
//! window recovers by itself). Two ways a WebView ends up drawing nothing
//! with no word to the shell, both silent in wry 0.57:
//!
//! - **Its content process ended.** macOS ends a WebView's WebContent
//!   process under memory pressure (and WebKit when it outgrows its limit, or
//!   it crashes); the view then shows nothing until someone reloads it, and
//!   Tauri does nothing by default. `on_terminated` reloads it, at once the
//!   first time and with a growing pause when it keeps happening, so a page
//!   that dies on every load does not spin.
//! - **A load the shell asked for never finished.** A navigation that fails
//!   before anything arrives (the daemon restarting at that moment) fires no
//!   event at all; the window keeps an address on the daemon and draws
//!   nothing, and the monitor, seeing it "already there", left it so.
//!   `LoadWatch` notices that no page finished loading in time and the
//!   monitor asks again (shell.rs).
//!
//! Each is written to the app's log (applog.rs), so the next report of a
//! white window can say which it was.
// The reload is macOS-only (on_web_content_process_terminate); elsewhere
// these are built for the tests alone.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How far back the terminations of one webview are counted.
pub const CRASH_WINDOW: Duration = Duration::from_secs(10 * 60);

/// The pause before reloading a webview whose content process ended, given
/// how many times it ended before in `CRASH_WINDOW`: at once, then 2 s,
/// 10 s, and a minute from the fourth on.
pub fn reload_delay(before: usize) -> Duration {
    match before {
        0 => Duration::ZERO,
        1 => Duration::from_secs(2),
        2 => Duration::from_secs(10),
        _ => Duration::from_secs(60),
    }
}

/// The terminations seen, per webview label.
#[derive(Default)]
pub struct Crashes(Mutex<HashMap<String, Vec<Instant>>>);

impl Crashes {
    /// Records one termination of `label` at `now`; returns how many came
    /// before it within `CRASH_WINDOW`.
    pub fn record(&self, label: &str, now: Instant) -> usize {
        let mut m = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let times = m.entry(label.to_string()).or_default();
        times.retain(|t| now.saturating_duration_since(*t) < CRASH_WINDOW);
        let before = times.len();
        times.push(now);
        before
    }
}

/// The data directory, for the log line the termination handler writes.
pub struct LogDir(pub PathBuf);

/// A webview's content process ended: log it and reload the webview (all
/// of the app's windows and a browser tab's page alike). Called on the main
/// thread by WebKit's navigation delegate, so the pause and the reload are
/// on a thread of their own.
#[cfg(target_os = "macos")]
pub fn on_terminated<R: tauri::Runtime>(webview: &tauri::Webview<R>) {
    use tauri::Manager;
    let app = webview.app_handle();
    let label = webview.label().to_string();
    let before = app
        .try_state::<Crashes>()
        .map_or(0, |c| c.record(&label, Instant::now()));
    let delay = reload_delay(before);
    if let Some(dir) = app.try_state::<LogDir>() {
        crate::applog::line(
            &dir.0,
            &format!(
                "webview {label}: its web content process ended (macOS ends it under memory pressure, or it crashed); reloading in {} s ({} before in the last 10 min)",
                delay.as_secs(),
                before
            ),
        );
    }
    let w = webview.clone();
    std::thread::spawn(move || {
        std::thread::sleep(delay);
        if w.label() == crate::shell::MAIN {
            crate::shell::expect_load();
        }
        let _ = w.reload();
    });
}

/// The grace a load the shell asked for has to finish, before the first
/// retry; it doubles for each retry after, up to `MAX_GRACE`.
pub const LOAD_GRACE: Duration = Duration::from_secs(10);
pub const MAX_GRACE: Duration = Duration::from_secs(60);

/// Whether the main window's page, asked for by the shell, finished
/// loading. `loads` is the count of finished loads (shell.rs).
#[derive(Debug)]
pub struct LoadWatch {
    asked: Option<(Instant, u64)>,
    tries: u32,
}

impl LoadWatch {
    /// Nothing asked yet; `const`, for a static.
    pub const fn new() -> Self {
        Self {
            asked: None,
            tries: 0,
        }
    }

    /// The shell asked the window for a page at `now`, with `loads` loads
    /// finished so far.
    pub fn asked(&mut self, now: Instant, loads: u64) {
        self.asked = Some((now, loads));
    }

    /// The grace for the current try.
    pub fn grace(&self) -> Duration {
        LOAD_GRACE
            .saturating_mul(1u32 << self.tries.min(8))
            .min(MAX_GRACE)
    }

    /// Whether the page asked for is overdue: no load has finished since,
    /// and its grace is up. True once per grace; the caller asks again (and
    /// the next grace is longer). A finished load ends the watch.
    pub fn overdue(&mut self, now: Instant, loads: u64) -> bool {
        let Some((at, before)) = self.asked else {
            return false;
        };
        if loads > before {
            *self = Self::new();
            return false;
        }
        if now.saturating_duration_since(at) < self.grace() {
            return false;
        }
        self.tries += 1;
        self.asked = Some((now, loads));
        true
    }

    /// Retries made for the page in hand.
    pub fn tries(&self) -> u32 {
        self.tries
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_termination_reloads_at_once_and_repeats_wait_longer() {
        let c = Crashes::default();
        let t = Instant::now();
        let delays: Vec<u64> = (0..5)
            .map(|i| reload_delay(c.record("main", t + Duration::from_secs(i))).as_secs())
            .collect();
        assert_eq!(delays, [0, 2, 10, 60, 60]);
        // Another webview keeps its own count.
        assert_eq!(c.record("mail", t), 0);
    }

    #[test]
    fn terminations_older_than_the_window_are_forgotten() {
        let c = Crashes::default();
        let t = Instant::now();
        c.record("main", t);
        c.record("main", t + Duration::from_secs(1));
        assert_eq!(
            c.record("main", t + CRASH_WINDOW + Duration::from_secs(2)),
            0
        );
    }

    #[test]
    fn a_load_that_finishes_ends_the_watch() {
        let mut w = LoadWatch::new();
        let t = Instant::now();
        w.asked(t, 3);
        assert!(!w.overdue(t + Duration::from_secs(5), 3));
        assert!(!w.overdue(t + Duration::from_secs(30), 4));
        // Nothing asked any more.
        assert!(!w.overdue(t + Duration::from_secs(300), 4));
    }

    #[test]
    fn a_load_that_never_finishes_is_asked_again_with_a_growing_grace() {
        let mut w = LoadWatch::new();
        let t = Instant::now();
        w.asked(t, 0);
        assert!(!w.overdue(t + Duration::from_secs(9), 0));
        assert!(w.overdue(t + LOAD_GRACE, 0));
        assert_eq!(w.tries(), 1);
        // The next try waits twice as long from the retry.
        let t2 = t + LOAD_GRACE;
        assert!(!w.overdue(t2 + Duration::from_secs(19), 0));
        assert!(w.overdue(t2 + Duration::from_secs(20), 0));
        assert_eq!(w.grace(), Duration::from_secs(40));
        for _ in 0..10 {
            w.tries += 1;
        }
        assert_eq!(w.grace(), MAX_GRACE);
        // Once a load finishes, the count starts over.
        assert!(!w.overdue(t2 + Duration::from_secs(500), 1));
        assert_eq!(w.tries(), 0);
    }
}
