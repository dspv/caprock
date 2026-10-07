//! Notifications on Linux through the desktop's notification server (D-Bus,
//! org.freedesktop.Notifications) rather than the official plugin, which
//! shows a title and a body and reports no clicks: a click there did nothing,
//! so a notification only informed (owner, 2026-10-07: "fix it if you can").
//! Here the body's default action opens the session, and an approval carries
//! Approve and Deny, answered by `notify::respond` as on macOS. A server that
//! offers no actions still shows the text; one that is missing fails the
//! call, and the caller falls back to the plugin.

use crate::notify::{Buttons, Reply};
#[cfg(target_os = "linux")]
use crate::notify::{Note, Origin};
#[cfg(target_os = "linux")]
use tauri::{AppHandle, Runtime};

/// The buttons a notification shows, as (identifier, label) pairs; "default"
/// is the click on the body, which servers do not draw as a button.
pub fn actions(buttons: Buttons) -> Vec<(&'static str, &'static str)> {
    let mut out = vec![("default", "Open")];
    match buttons {
        Buttons::ApproveDeny => out.extend([("allow", "Approve"), ("deny", "Deny")]),
        Buttons::OpenDeny => out.extend([("open", "Open"), ("deny", "Deny")]),
        Buttons::None => {}
    }
    out
}

/// What an action the server reports means; None for a close or a dismissal.
pub fn reply_for(action: &str) -> Option<Reply> {
    match action {
        "default" | "open" => Some(Reply::Open),
        "allow" => Some(Reply::Allow),
        "deny" => Some(Reply::Deny),
        _ => None,
    }
}

/// Shows the note and waits for its answer on a thread of its own; the wait
/// ends when the reader acts or the notification closes.
#[cfg(target_os = "linux")]
pub fn show<R: Runtime>(app: &AppHandle<R>, note: &Note) -> Result<(), String> {
    let mut n = notify_rust::Notification::new();
    n.appname("Caprock").summary(&note.title).body(&note.body);
    for (id, label) in actions(note.buttons) {
        n.action(id, label);
    }
    let handle = n.show().map_err(|e| e.to_string())?;
    let app = app.clone();
    let origin = Origin {
        session_id: note.session_id.clone(),
        prompt_id: note.prompt_id.clone(),
        title: note.title.clone(),
    };
    std::thread::spawn(move || {
        handle.wait_for_action(|action| {
            if let Some(reply) = reply_for(action) {
                crate::notify::respond(&app, reply, origin);
            }
        });
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_click_opens_and_the_buttons_answer() {
        assert_eq!(reply_for("default"), Some(Reply::Open));
        assert_eq!(reply_for("open"), Some(Reply::Open));
        assert_eq!(reply_for("allow"), Some(Reply::Allow));
        assert_eq!(reply_for("deny"), Some(Reply::Deny));
        assert_eq!(reply_for("__closed"), None);
    }

    #[test]
    fn an_approval_carries_its_buttons() {
        let ids = |b| actions(b).into_iter().map(|(i, _)| i).collect::<Vec<_>>();
        assert_eq!(ids(Buttons::None), ["default"]);
        assert_eq!(ids(Buttons::ApproveDeny), ["default", "allow", "deny"]);
        assert_eq!(ids(Buttons::OpenDeny), ["default", "open", "deny"]);
    }
}
