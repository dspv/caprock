//! OS notifications (WP-09, .ai/21-app.md § Notifications). The daemon decides
//! when and says what (the `notify` frame); the page decides whether this
//! window is already showing that session; this puts the words on screen.
//!
//! On macOS, inside the app bundle, a notification goes through
//! UNUserNotificationCenter (`notify_macos.rs`): an approval carries Approve
//! and Deny, answered here, from Rust, with the frame's `prompt_id` (ADR-035),
//! so neither the window nor the page has to wake up; a click on the body
//! opens the session. Elsewhere the official notification plugin shows a title
//! and a body and reports no clicks or actions, so Approve and Deny are
//! answered in the app: a click on the notification brings the app forward,
//! and the page opens the prompt (`ui/src/lib/notify.ts`).

use std::io::Write;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_notification::NotificationExt;

/// What a lock screen can use; the daemon's text is already shorter.
const TITLE_MAX: usize = 120;
const BODY_MAX: usize = 400;

/// The buttons a notification carries besides a click on its body.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Buttons {
    None,
    /// Approve and Deny: the notification shows the whole request.
    ApproveDeny,
    /// Open and Deny: the request is longer than the notification shows, so
    /// it is approved on the prompt card, where it can be read.
    OpenDeny,
}

/// One notification, ready to show.
#[derive(Debug, Clone, PartialEq)]
pub struct Note {
    /// Names it to the OS; a later one with the same id replaces it.
    pub id: String,
    pub title: String,
    pub body: String,
    pub session_id: Option<String>,
    pub prompt_id: Option<String>,
    pub buttons: Buttons,
}

/// What the reader did with a notification.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reply {
    Open,
    Allow,
    Deny,
}

/// The notification a reply came from.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Origin {
    pub session_id: Option<String>,
    pub prompt_id: Option<String>,
    pub title: String,
}

/// How an answer from a notification went.
#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    Answered,
    /// 409: the prompt is no longer waiting (ADR-035).
    Stale,
    Failed(String),
}

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

/// A session or prompt id safe to put in a request path: the daemon's ids
/// are UUIDs and random hex, so anything else is not one of them.
fn is_id(s: &str) -> bool {
    (1..=128).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

/// The buttons for a frame's `actions`; none without a session and a prompt
/// to answer.
pub fn buttons(session: Option<&str>, prompt: Option<&str>, actions: &[String]) -> Buttons {
    if session.is_none() || prompt.is_none() {
        return Buttons::None;
    }
    let has = |a: &str| actions.iter().any(|x| x == a);
    match (has("allow"), has("deny")) {
        (true, true) => Buttons::ApproveDeny,
        (false, true) => Buttons::OpenDeny,
        _ => Buttons::None,
    }
}

/// Show one OS notification. `session_id`, `prompt_id` and `actions` come
/// from the notify frame; without them it is a title and a body. With
/// `CAPROCK_APP_NOTIFY_LOG` set (automated checks on a machine someone is
/// using; not a user setting) it is appended to that file instead of shown.
#[tauri::command]
pub fn notify<R: Runtime>(
    title: String,
    body: String,
    id: Option<String>,
    session_id: Option<String>,
    prompt_id: Option<String>,
    actions: Option<Vec<String>>,
    app: AppHandle<R>,
) -> Result<(), String> {
    let (title, body) = prepare(&title, &body)?;
    let session_id = session_id.filter(|s| is_id(s));
    let prompt_id = prompt_id.filter(|s| is_id(s));
    let buttons = buttons(
        session_id.as_deref(),
        prompt_id.as_deref(),
        &actions.unwrap_or_default(),
    );
    let id = id
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("caprock-{}", unique()));
    show(
        &app,
        Note {
            id,
            title,
            body,
            session_id,
            prompt_id,
            buttons,
        },
    )
}

/// At most this many ids per call; a page withdraws one session's at a time.
const WITHDRAW_MAX: usize = 64;

/// Withdraw delivered notifications by their notify ids: the page calls it
/// when a prompt it notified about is answered elsewhere (the terminal, the
/// prompt card, a phone), so Notification Center holds no stale Approve
/// button. macOS only; elsewhere the plugin cannot withdraw and this does
/// nothing.
#[tauri::command]
pub fn withdraw_notifications(ids: Vec<String>) -> Result<(), String> {
    let ids = withdrawable(ids)?;
    if let Some(path) = std::env::var_os("CAPROCK_APP_NOTIFY_LOG") {
        let line = serde_json::json!({ "withdraw": ids }).to_string();
        return std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .and_then(|mut f| writeln!(f, "{line}"))
            .map_err(|e| e.to_string());
    }
    #[cfg(target_os = "macos")]
    crate::notify_macos::withdraw(&ids);
    Ok(())
}

/// The ids a withdraw may name: non-empty, short, and not too many.
fn withdrawable(ids: Vec<String>) -> Result<Vec<String>, String> {
    if ids.len() > WITHDRAW_MAX {
        return Err(format!("at most {WITHDRAW_MAX} notifications at once"));
    }
    Ok(ids
        .into_iter()
        .filter(|id| !id.is_empty() && id.len() <= 256)
        .collect())
}

fn show<R: Runtime>(app: &AppHandle<R>, note: Note) -> Result<(), String> {
    if let Some(path) = std::env::var_os("CAPROCK_APP_NOTIFY_LOG") {
        let line = serde_json::json!({
            "title": note.title,
            "body": note.body,
            "session_id": note.session_id,
            "prompt_id": note.prompt_id,
            "buttons": format!("{:?}", note.buttons),
        })
        .to_string();
        return std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .and_then(|mut f| writeln!(f, "{line}"))
            .map_err(|e| e.to_string());
    }
    #[cfg(target_os = "macos")]
    let Some(note) = crate::notify_macos::show(note) else {
        return Ok(());
    };
    plain(app, &note.title, &note.body)
}

/// Through the official plugin: a title and a body, no buttons.
pub fn plain<R: Runtime>(app: &AppHandle<R>, title: &str, body: &str) -> Result<(), String> {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}

fn unique() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default()
}

/// A click or a button on a notification. Approve and Deny answer on the
/// daemon this app is attached to, off the main thread, and say so only when
/// the answer did not land; a click opens the session.
pub fn respond<R: Runtime>(app: &AppHandle<R>, reply: Reply, origin: Origin) {
    let Origin {
        session_id,
        prompt_id,
        title,
    } = origin;
    let (Reply::Allow | Reply::Deny, Some(session), Some(prompt)) =
        (reply, session_id.clone(), prompt_id)
    else {
        match session_id {
            Some(s) => crate::tray::open_session(app, &s),
            None => crate::hotkey::show(app),
        }
        return;
    };
    let app = app.clone();
    std::thread::spawn(move || {
        let port = match app.state::<crate::commands::Sup>().state() {
            crate::supervisor::State::Connected { port, .. } => Some(port),
            _ => None,
        };
        let outcome = answer(port, &session, &prompt, reply);
        if let Some((t, b)) = follow_up(&outcome, &title) {
            let note = Note {
                id: format!("caprock-answer-{}", unique()),
                title: t,
                body: b,
                session_id: Some(session),
                prompt_id: None,
                buttons: Buttons::None,
            };
            let _ = show(&app, note);
        }
    });
}

/// `POST /v1/agents/{id}/permission` on loopback, with the prompt's id, so a
/// prompt that has since changed is refused (409) rather than answered.
pub fn answer(port: Option<u16>, session: &str, prompt: &str, reply: Reply) -> Outcome {
    let Some(port) = port else {
        return Outcome::Failed("Caprock's daemon is not running".into());
    };
    if !is_id(session) || !is_id(prompt) {
        return Outcome::Failed("the notification does not name a prompt".into());
    }
    let choice = if reply == Reply::Allow {
        "allow"
    } else {
        "deny"
    };
    let body = serde_json::json!({ "id": prompt, "choice": choice }).to_string();
    let path = format!("/v1/agents/{session}/permission");
    match crate::discovery::post_json(port, &path, &body) {
        Ok((200..=299, _)) => Outcome::Answered,
        Ok((409, _)) => Outcome::Stale,
        Ok((code, text)) => Outcome::Failed(format!(
            "the daemon answered {code}: {}",
            clip(text.trim(), 120)
        )),
        Err(e) => Outcome::Failed(format!("the daemon did not answer ({e})")),
    }
}

/// The notification that follows an answer that did not land; none when it
/// did, since the prompt card and the badge already change.
pub fn follow_up(outcome: &Outcome, title: &str) -> Option<(String, String)> {
    match outcome {
        Outcome::Answered => None,
        Outcome::Stale => Some((
            "Already answered".into(),
            format!("{title}\nThat prompt is no longer waiting, so nothing was sent."),
        )),
        Outcome::Failed(why) => Some((
            "Could not answer".into(),
            format!("{title}\nNothing was sent: {why}. Click to open the session."),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::net::TcpListener;

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

    #[test]
    fn a_withdraw_names_a_bounded_set_of_ids() {
        let ids = vec!["approval-s-1".to_string(), String::new(), "x".repeat(300)];
        assert_eq!(withdrawable(ids).unwrap(), vec!["approval-s-1".to_string()]);
        assert!(withdrawable(vec!["a".into(); WITHDRAW_MAX + 1]).is_err());
    }

    #[test]
    fn buttons_follow_the_frame_and_need_a_prompt() {
        let both = vec!["allow".to_string(), "deny".to_string()];
        let deny = vec!["deny".to_string()];
        assert_eq!(buttons(Some("s"), Some("p"), &both), Buttons::ApproveDeny);
        assert_eq!(buttons(Some("s"), Some("p"), &deny), Buttons::OpenDeny);
        assert_eq!(buttons(Some("s"), Some("p"), &[]), Buttons::None);
        assert_eq!(buttons(Some("s"), None, &both), Buttons::None);
        assert_eq!(buttons(None, Some("p"), &both), Buttons::None);
    }

    #[test]
    fn only_plain_ids_reach_a_request_path() {
        assert!(is_id("3f2a-9c_1.x"));
        for bad in ["", "a/b", "a b", "..%2f", "a?x=1", &"a".repeat(129)] {
            assert!(!is_id(bad), "{bad}");
        }
        assert_eq!(
            answer(Some(1), "../x", "p", Reply::Allow),
            Outcome::Failed("the notification does not name a prompt".into())
        );
    }

    /// A loopback daemon that answers one request with `status` and hands
    /// back what it received.
    fn daemon(status: u16) -> (u16, std::thread::JoinHandle<String>) {
        let ln = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = ln.local_addr().unwrap().port();
        let h = std::thread::spawn(move || {
            let (mut c, _) = ln.accept().unwrap();
            let mut req = String::new();
            let mut buf = [0u8; 1024];
            while !req.contains("\r\n\r\n") || !req.ends_with('}') {
                match c.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => req.push_str(&String::from_utf8_lossy(&buf[..n])),
                }
            }
            let _ = write!(c, "HTTP/1.0 {status} X\r\nContent-Length: 2\r\n\r\n{{}}");
            req
        });
        (port, h)
    }

    #[test]
    fn approve_posts_the_prompt_id_as_json() {
        let (port, h) = daemon(204);
        assert_eq!(
            answer(Some(port), "s1", "p1", Reply::Allow),
            Outcome::Answered
        );
        let req = h.join().unwrap();
        assert!(
            req.starts_with("POST /v1/agents/s1/permission HTTP/1.0\r\n"),
            "{req}"
        );
        assert!(req.contains("Content-Type: application/json\r\n"), "{req}");
        assert!(req.ends_with(r#"{"choice":"allow","id":"p1"}"#), "{req}");
    }

    #[test]
    fn a_stale_prompt_says_already_answered() {
        let (port, h) = daemon(409);
        let outcome = answer(Some(port), "s1", "p1", Reply::Deny);
        assert!(h.join().unwrap().contains(r#""choice":"deny""#));
        assert_eq!(outcome, Outcome::Stale);
        let (t, b) = follow_up(&outcome, "Needs approval · api").unwrap();
        assert_eq!(t, "Already answered");
        assert!(b.starts_with("Needs approval · api\n"), "{b}");
    }

    #[test]
    fn a_failed_answer_says_why_and_a_landed_one_says_nothing() {
        let gone = answer(None, "s1", "p1", Reply::Allow);
        let (t, b) = follow_up(&gone, "Needs approval · api").unwrap();
        assert_eq!(t, "Could not answer");
        assert!(b.contains("not running"), "{b}");
        assert_eq!(follow_up(&Outcome::Answered, "x"), None);
    }
}
