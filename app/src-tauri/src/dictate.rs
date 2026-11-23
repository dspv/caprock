//! Voice input in the chat (ADR-102): the dashboard's microphone button asks
//! the shell to listen, and the words come back to the page as they are
//! heard. macOS only, through Apple's speech recognition on this Mac
//! (`dictate_macos.rs`, `requiresOnDeviceRecognition`): no audio and no
//! text leave the machine, and a language this Mac cannot recognise on its
//! own is refused rather than sent to Apple's servers. Elsewhere the status
//! says unsupported and the page hides the button.
//!
//! The page calls `dictation_start` with a language and gets an id back at
//! once; everything after that — partial words, the final words, the end and
//! why — arrives as `caprock:dictation` events on the same page, each with
//! that id (`event_script`). `dictation_stop` ends it: the words heard so far
//! are finished and sent as the final ones; with `cancel`, dropped.
// The recogniser is macOS-only (dictate_macos.rs); elsewhere the events,
// error codes and restart rules are built for the tests alone.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
#[cfg(target_os = "macos")]
use tauri::Manager;
use tauri::{Runtime, Webview};

/// The DOM event the page listens for (ui/src/lib/deskvoice.ts).
pub const EVENT: &str = "caprock:dictation";

/// Why dictation is or is not offered here.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Status {
    pub supported: bool,
    /// Without support: why, as a code the page explains.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
}

/// One thing a dictation says to the page.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Event {
    /// macOS is asking for the microphone or speech recognition: the page
    /// keeps the dictation on through a release meanwhile.
    Asking { id: u64 },
    /// The microphone is on and the recogniser listens.
    Listening { id: u64 },
    /// Everything heard so far, still being guessed.
    Partial { id: u64, text: String },
    /// The recogniser's last word on what was said.
    Final { id: u64, text: String },
    /// It is over; `error` says why when it is not the usual end.
    End {
        id: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<&'static str>,
    },
}

/// Where a dictation's events go: the page that started it.
pub type Sink = Arc<dyn Fn(Event) + Send + Sync>;

/// The script that hands one event to the page.
pub fn event_script(e: &Event) -> String {
    let detail = serde_json::to_string(e).unwrap_or_else(|_| "{}".into());
    format!("window.dispatchEvent(new CustomEvent('{EVENT}', {{ detail: {detail} }}))")
}

/// A BCP-47 tag as an Apple locale identifier: `ru-RU` becomes `ru_RU`.
/// Anything but letters, digits, `-` and `_` is refused, so a page cannot
/// hand the framework something that is not a language.
pub fn locale_id(tag: &str) -> Option<String> {
    let t = tag.trim();
    if t.is_empty()
        || t.len() > 35
        || !t
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return None;
    }
    Some(t.replace('-', "_"))
}

/// What an error from Apple's recogniser means for the page: `None` when it
/// is only the end (a cancel, which is ours), else the code the page
/// explains. `kAFAssistantErrorDomain` is the recogniser's own domain; its
/// codes are not in the SDK headers, these are the ones it is known to send.
pub fn apple_error(domain: &str, code: isize) -> Option<&'static str> {
    match (domain, code) {
        ("kAFAssistantErrorDomain", 1110) => Some("no-speech"),
        ("kAFAssistantErrorDomain", 203 | 216 | 209 | 301) => None,
        ("kAFAssistantErrorDomain", 1700) => Some("speech-denied"),
        ("SFSpeechErrorDomain", 2) => Some("no-microphone"),
        _ => Some("failed"),
    }
}

/// How many times one dictation starts a new request after Apple ended one.
pub const MAX_RESTARTS: u32 = 40;
/// Requests in a row that heard nothing before it gives up.
pub const MAX_EMPTY_RESTARTS: u32 = 3;

/// Whether a request Apple ended (`code`: why, `None` when it simply
/// finished) is replaced by a new one: only while the user has not asked to
/// stop, never after a refusal or a missing microphone, and not forever;
/// `empty_in_row` counts this request when it heard nothing.
pub fn should_restart(
    stopping: bool,
    code: Option<&'static str>,
    restarts: u32,
    empty_in_row: u32,
) -> bool {
    if stopping || restarts >= MAX_RESTARTS || empty_in_row >= MAX_EMPTY_RESTARTS {
        return false;
    }
    matches!(code, None | Some("no-speech") | Some("failed"))
}

/// What earlier requests heard, then what the current one heard, a space
/// between: the text the page shows for a dictation that was restarted.
pub fn join_heard(committed: &str, current: &str) -> String {
    let c = current.trim_start();
    if c.trim().is_empty() {
        return committed.to_string();
    }
    if committed.is_empty() {
        return c.to_string();
    }
    if committed.ends_with(char::is_whitespace) {
        format!("{committed}{c}")
    } else {
        format!("{committed} {c}")
    }
}

static NEXT: AtomicU64 = AtomicU64::new(1);

/// A fresh id for a dictation, never 0.
pub fn next_id() -> u64 {
    NEXT.fetch_add(1, Ordering::Relaxed)
}

/// A sink that evaluates each event in `webview`.
pub fn sink_for<R: Runtime>(webview: Webview<R>) -> Sink {
    Arc::new(move |e: Event| {
        let _ = webview.eval(event_script(&e));
    })
}

/// Whether this build can dictate: macOS from an app bundle (outside one
/// there is no Info.plist and asking for permission would end the process).
#[tauri::command]
pub fn dictation_status() -> Status {
    #[cfg(target_os = "macos")]
    {
        crate::dictate_macos::status()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Status {
            supported: false,
            reason: Some("unsupported"),
        }
    }
}

/// Starts listening for `lang` (a BCP-47 tag); the id names its events.
/// Asks for the microphone and speech recognition the first time. A
/// dictation already running is cancelled: one at a time.
#[tauri::command]
pub fn dictation_start<R: Runtime>(webview: Webview<R>, lang: String) -> Result<u64, String> {
    let locale = locale_id(&lang).ok_or_else(|| format!("not a language: {lang}"))?;
    let id = next_id();
    let sink = sink_for(webview.clone());
    #[cfg(target_os = "macos")]
    {
        let app = webview.app_handle().clone();
        crate::dictate_macos::start(app, id, locale, sink);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = locale;
        sink(Event::End {
            id,
            error: Some("unsupported"),
        });
    }
    Ok(id)
}

/// Stops dictation `id`: what was heard is finished and sent as the final
/// words; with `cancel`, nothing more is sent but the end.
#[tauri::command]
pub fn dictation_stop<R: Runtime>(webview: Webview<R>, id: u64, cancel: Option<bool>) {
    #[cfg(target_os = "macos")]
    crate::dictate_macos::stop(webview.app_handle(), id, cancel.unwrap_or(false));
    #[cfg(not(target_os = "macos"))]
    let _ = (webview, id, cancel);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_reach_the_page_as_one_custom_event_with_their_id() {
        let js = event_script(&Event::Partial {
            id: 7,
            text: "hello \"there\"</script>".into(),
        });
        assert!(js.starts_with("window.dispatchEvent(new CustomEvent('caprock:dictation'"));
        assert!(js.contains(r#""kind":"partial""#), "{js}");
        assert!(js.contains(r#""id":7"#), "{js}");
        // The text is JSON, so a quote cannot end the string early.
        assert!(js.contains(r#"hello \"there\""#), "{js}");
        let end = event_script(&Event::End { id: 7, error: None });
        assert!(end.contains(r#"{"kind":"end","id":7}"#), "{end}");
        let err = event_script(&Event::End {
            id: 8,
            error: Some("mic-denied"),
        });
        assert!(err.contains(r#""error":"mic-denied""#), "{err}");
        let fin = event_script(&Event::Final {
            id: 9,
            text: "done".into(),
        });
        assert!(fin.contains(r#""kind":"final""#), "{fin}");
    }

    #[test]
    fn a_language_tag_becomes_a_locale_and_nothing_else_does() {
        assert_eq!(locale_id("ru-RU").as_deref(), Some("ru_RU"));
        assert_eq!(locale_id("en_US").as_deref(), Some("en_US"));
        assert_eq!(locale_id(" de ").as_deref(), Some("de"));
        assert_eq!(locale_id("zh-Hans-CN").as_deref(), Some("zh_Hans_CN"));
        for bad in ["", "   ", "en US", "en;rm", "../x", "ä", &"a".repeat(40)] {
            assert_eq!(locale_id(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn apples_errors_map_to_what_the_page_says() {
        assert_eq!(
            apple_error("kAFAssistantErrorDomain", 1110),
            Some("no-speech")
        );
        // A cancel is ours: the end, not a fault.
        assert_eq!(apple_error("kAFAssistantErrorDomain", 216), None);
        assert_eq!(apple_error("kAFAssistantErrorDomain", 203), None);
        assert_eq!(apple_error("SFSpeechErrorDomain", 2), Some("no-microphone"));
        assert_eq!(apple_error("NSOSStatusErrorDomain", -1), Some("failed"));
    }

    #[test]
    fn a_request_apple_ended_is_replaced_until_the_user_stops() {
        // Ended by itself, or after a pause, while the user still listens.
        assert!(should_restart(false, None, 0, 0));
        assert!(should_restart(false, Some("no-speech"), 3, 1));
        assert!(should_restart(false, Some("failed"), 0, 0));
        // The user's release, click, Enter or Esc: the end.
        assert!(!should_restart(true, None, 0, 0));
        // A refusal or a missing microphone cannot be listened past.
        for code in ["mic-denied", "speech-denied", "no-microphone"] {
            assert!(!should_restart(false, Some(code), 0, 0), "{code}");
        }
        // Not forever.
        assert!(!should_restart(false, None, MAX_RESTARTS, 0));
        assert!(!should_restart(false, None, 0, MAX_EMPTY_RESTARTS));
    }

    #[test]
    fn what_earlier_requests_heard_stays_in_front() {
        assert_eq!(join_heard("", "hello"), "hello");
        assert_eq!(join_heard("first part.", "second"), "first part. second");
        assert_eq!(join_heard("first ", " second"), "first second");
        assert_eq!(join_heard("kept", ""), "kept");
        assert_eq!(join_heard("kept", "   "), "kept");
    }

    #[test]
    fn the_page_is_told_when_macos_asks_and_when_it_listens() {
        assert!(event_script(&Event::Asking { id: 3 }).contains(r#"{"kind":"asking","id":3}"#));
        assert!(
            event_script(&Event::Listening { id: 3 }).contains(r#"{"kind":"listening","id":3}"#)
        );
    }

    #[test]
    fn ids_are_fresh_and_never_zero() {
        let a = next_id();
        let b = next_id();
        assert!(a > 0 && b > a);
    }

    #[test]
    fn the_status_says_unsupported_off_macos() {
        let s = dictation_status();
        if cfg!(target_os = "macos") {
            // A test binary is not an app bundle: no Info.plist to ask with.
            assert!(!s.supported);
            assert_eq!(s.reason, Some("unbundled"));
        } else {
            assert_eq!(
                s,
                Status {
                    supported: false,
                    reason: Some("unsupported")
                }
            );
        }
    }
}
