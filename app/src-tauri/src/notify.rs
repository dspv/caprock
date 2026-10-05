//! OS notifications (WP-09, .ai/21-app.md § Notifications). The daemon decides
//! when and says what (the `notify` frame); the page decides whether this
//! window is already showing that session; this only puts the words on screen,
//! through the official notification plugin.
//!
//! The plugin's desktop half shows a title and a body and reports no clicks or
//! actions, so Approve and Deny are answered in the app: a click on the
//! notification brings the app forward, and the page opens the prompt
//! (`ui/src/lib/notify.ts`).

use std::io::Write;
use tauri::{AppHandle, Runtime};
use tauri_plugin_notification::NotificationExt;

/// What a lock screen can use; the daemon's text is already shorter.
const TITLE_MAX: usize = 120;
const BODY_MAX: usize = 400;

/// Trims and clips a notification's text, refusing one with no title.
pub fn prepare(title: &str, body: &str) -> Result<(String, String), String> {
    let title = clip(title.trim(), TITLE_MAX);
    if title.is_empty() {
        return Err("a notification needs a title".into());
    }
    Ok((title, clip(body.trim(), BODY_MAX)))
}

fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max - 1).collect();
    out.push('…');
    out
}

/// Show one OS notification. With `CAPROCK_APP_NOTIFY_LOG` set (automated
/// checks on a machine someone is using; not a user setting) it is appended
/// to that file instead of shown.
#[tauri::command]
pub fn notify<R: Runtime>(title: String, body: String, app: AppHandle<R>) -> Result<(), String> {
    let (title, body) = prepare(&title, &body)?;
    if let Some(path) = std::env::var_os("CAPROCK_APP_NOTIFY_LOG") {
        let line = serde_json::json!({ "title": title, "body": body }).to_string();
        return std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .and_then(|mut f| writeln!(f, "{line}"))
            .map_err(|e| e.to_string());
    }
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_notification_needs_a_title() {
        assert!(prepare("  ", "body").is_err());
    }

    #[test]
    fn long_text_is_clipped_on_a_character() {
        let (t, b) = prepare(&"é".repeat(200), &" x ".repeat(300)).unwrap();
        assert_eq!(t.chars().count(), TITLE_MAX);
        assert!(t.ends_with('…'));
        assert_eq!(b.chars().count(), BODY_MAX);
    }
}
