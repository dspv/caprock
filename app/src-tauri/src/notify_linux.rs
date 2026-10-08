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
/// is the click on the body. GNOME and KDE do not draw it as a button, but
/// XFCE and dunst do — so Open is never added a second time: XFCE showed
/// "Open | Open | Deny", and its body click only dismisses, which makes the
/// drawn "default" the way to open there.
pub fn actions(buttons: Buttons) -> Vec<(&'static str, &'static str)> {
    let mut out = vec![("default", "Open")];
    match buttons {
        Buttons::ApproveDeny => out.extend([("allow", "Approve"), ("deny", "Deny")]),
        Buttons::OpenDeny => out.push(("deny", "Deny")),
        Buttons::None => {}
    }
    out
}

/// The server's ids of the notifications on screen, by Caprock's own id, so
/// one answered elsewhere can be taken down (`withdraw`): left up, its
/// Approve looked live and did nothing.
#[cfg(target_os = "linux")]
static SHOWN: std::sync::Mutex<Option<std::collections::HashMap<String, u32>>> =
    std::sync::Mutex::new(None);

#[cfg(target_os = "linux")]
fn shown() -> std::sync::MutexGuard<'static, Option<std::collections::HashMap<String, u32>>> {
    SHOWN.lock().unwrap_or_else(|e| e.into_inner())
}

/// Takes a notification down by the server's id, with CloseNotification
/// itself. Replacing it with an empty one first (all notify-rust offers
/// without a handle) left a blank "Caprock" in dunst's history, and on a
/// server that had already closed it made a new blank one. An id the server
/// has dropped is answered with an error, which is ignored.
#[cfg(target_os = "linux")]
fn close_server_id(server_id: u32) {
    if let Ok(c) = zbus::blocking::Connection::session() {
        let _ = c.call_method(
            Some("org.freedesktop.Notifications"),
            "/org/freedesktop/Notifications",
            Some("org.freedesktop.Notifications"),
            "CloseNotification",
            &(server_id,),
        );
    }
}

/// Withdraws the notifications Caprock showed under these ids, when the
/// prompt they ask about was answered somewhere else.
#[cfg(target_os = "linux")]
pub fn withdraw(ids: &[String]) {
    let gone: Vec<u32> = {
        let mut map = shown();
        let Some(map) = map.as_mut() else { return };
        ids.iter().filter_map(|id| map.remove(id)).collect()
    };
    for server_id in gone {
        close_server_id(server_id);
    }
}

/// Takes down every notification still on screen: after the app quits no one
/// listens to their buttons, and a press would silently do nothing.
#[cfg(target_os = "linux")]
pub fn withdraw_all() {
    let gone: Vec<u32> = shown()
        .take()
        .map(|m| m.into_values().collect())
        .unwrap_or_default();
    for server_id in gone {
        close_server_id(server_id);
    }
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
    // A question stays until it is answered. Left to the server (-1), dunst
    // and XFCE took it down after about ten seconds, its buttons with it.
    if note.buttons != Buttons::None {
        n.timeout(notify_rust::Timeout::Never);
    }
    let handle = n.show().map_err(|e| e.to_string())?;
    let server_id = handle.id();
    let note_id = note.id.clone();
    shown()
        .get_or_insert_with(Default::default)
        .insert(note_id.clone(), server_id);
    let app = app.clone();
    let origin = Origin {
        session_id: note.session_id.clone(),
        prompt_id: note.prompt_id.clone(),
        title: note.title.clone(),
    };
    std::thread::spawn(move || {
        let mut acted = false;
        handle.wait_for_action(|action| {
            if let Some(reply) = reply_for(action) {
                acted = true;
                crate::notify::respond(&app, reply, origin);
            }
        });
        // Answered here, or closed: either way it is no longer on screen as
        // ours. Dunst leaves an acted-on notification up, and a second press
        // there did nothing, so an answered one is taken down.
        let still_ours = {
            let mut map = shown();
            match map.as_mut() {
                Some(m) if m.get(&note_id) == Some(&server_id) => m.remove(&note_id).is_some(),
                _ => false,
            }
        };
        if acted && still_ours {
            close_server_id(server_id);
        }
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
        // Open once: XFCE and dunst draw the body-click action as a button.
        assert_eq!(ids(Buttons::OpenDeny), ["default", "deny"]);
    }
}
