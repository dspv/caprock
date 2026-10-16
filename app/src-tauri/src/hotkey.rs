//! The one global hotkey (F09): from any app it brings the window up; with
//! the window in front it hides it again. The choice is kept in
//! `<data_dir>/app-hotkey.json` (`{"accelerator": "..."}`, `null` for off);
//! without the file the default applies.

use crate::shell::MAIN;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Modifiers, Shortcut};

/// ⌃⌥⌘C on macOS: ⌥⌘C is Finder's Copy as Pathname and the browsers'
/// inspector. Win+Alt+C elsewhere: Ctrl+Alt is AltGr on Windows, and
/// AltGr+C types a letter on Polish, Czech and Hungarian layouts.
pub const DEFAULT: &str = if cfg!(target_os = "macos") {
    "control+alt+super+KeyC"
} else {
    "alt+super+KeyC"
};

const FILE: &str = "app-hotkey.json";

#[derive(Serialize, Deserialize)]
struct Saved {
    accelerator: Option<String>,
}

/// What Settings shows: the configured shortcut, whether the OS took it,
/// and why not.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Status {
    pub accelerator: Option<String>,
    pub default: &'static str,
    pub registered: bool,
    pub error: Option<String>,
    /// A Wayland session: compositors give no app a global key (app/README.md).
    pub wayland: bool,
}

pub struct Hotkey {
    file: PathBuf,
    current: Mutex<Status>,
}

impl Hotkey {
    pub fn new(data_dir: &Path) -> Self {
        let wayland = cfg!(target_os = "linux")
            && (std::env::var_os("WAYLAND_DISPLAY").is_some()
                || std::env::var("XDG_SESSION_TYPE").is_ok_and(|v| v == "wayland"));
        Self {
            file: data_dir.join(FILE),
            current: Mutex::new(Status {
                accelerator: None,
                default: DEFAULT,
                registered: false,
                error: None,
                wayland,
            }),
        }
    }

    pub fn status(&self) -> Status {
        self.current
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    fn saved(&self) -> Option<String> {
        let Ok(raw) = std::fs::read(&self.file) else {
            return Some(DEFAULT.into());
        };
        serde_json::from_slice::<Saved>(&raw)
            .map(|s| s.accelerator)
            .unwrap_or_else(|_| Some(DEFAULT.into()))
    }

    fn save(&self, accelerator: &Option<String>) -> Result<(), String> {
        let body = serde_json::to_vec(&Saved {
            accelerator: accelerator.clone(),
        })
        .map_err(|e| e.to_string())?;
        std::fs::write(&self.file, body).map_err(|e| format!("save {FILE}: {e}"))
    }

    fn set(&self, accelerator: Option<String>, error: Option<String>) -> Status {
        let mut g = self.current.lock().unwrap_or_else(|e| e.into_inner());
        g.registered = accelerator.is_some() && error.is_none();
        g.accelerator = accelerator;
        g.error = error;
        g.clone()
    }
}

/// Parses an accelerator ("control+alt+super+KeyC") into its canonical form.
/// Shift alone is not enough: Shift+C is a capital C in every app.
pub fn parse(accelerator: &str) -> Result<Shortcut, String> {
    let s: Shortcut = accelerator
        .parse()
        .map_err(|e| format!("not a shortcut: {accelerator} ({e})"))?;
    if (s.mods - Modifiers::SHIFT).is_empty() {
        return Err(format!(
            "{accelerator} needs Control, Option/Alt or Command/Win: a global shortcut must not take a key from typing"
        ));
    }
    Ok(s)
}

/// Registers the saved shortcut at launch. Failures are logged and shown in
/// Settings; the app runs without a hotkey.
pub fn load<R: Runtime>(app: &AppHandle<R>) {
    let hk = app.state::<Hotkey>();
    let wanted = hk.saved();
    let status = match &wanted {
        None => hk.set(None, None),
        Some(a) => match register(app, a) {
            Ok(canonical) => hk.set(Some(canonical), None),
            Err(e) => hk.set(Some(a.clone()), Some(e)),
        },
    };
    eprintln!("caprock-app: global hotkey {status:?}");
}

/// Replaces the shortcut (None turns it off). A shortcut the OS refuses
/// leaves the previous one in place and says why.
pub fn change<R: Runtime>(app: &AppHandle<R>, wanted: Option<String>) -> Result<Status, String> {
    let hk = app.state::<Hotkey>();
    let before = hk.status();
    if let Some(a) = &wanted {
        parse(a)?;
    }
    let gs = app.global_shortcut();
    gs.unregister_all().map_err(|e| e.to_string())?;
    let status = match &wanted {
        None => hk.set(None, None),
        Some(a) => match register(app, a) {
            Ok(canonical) => hk.set(Some(canonical), None),
            Err(e) => {
                if let Some(prev) = before.accelerator.filter(|_| before.registered) {
                    let _ = register(app, &prev);
                }
                return Err(e);
            }
        },
    };
    hk.save(&status.accelerator)?;
    eprintln!("caprock-app: global hotkey {status:?}");
    Ok(status)
}

fn register<R: Runtime>(app: &AppHandle<R>, accelerator: &str) -> Result<String, String> {
    let s = parse(accelerator)?;
    app.global_shortcut()
        .register(s)
        .map_err(|e| format!("{accelerator} is taken or refused by the system: {e}"))?;
    Ok(s.into_string())
}

/// The hotkey's action: hide the window when it is in front, else bring it up.
pub fn toggle<R: Runtime>(app: &AppHandle<R>) {
    let Some(w) = app.get_webview_window(MAIN) else {
        return;
    };
    if w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) {
        // On macOS hiding the app hands focus back to the app before it.
        #[cfg(target_os = "macos")]
        let _ = app.hide();
        #[cfg(not(target_os = "macos"))]
        let _ = w.hide();
        return;
    }
    show(app);
}

/// Brings the window up and gives it focus. The page hears it first
/// (`caprock:shown`), so a show the user asked for is not taken for a click
/// on a notification (ui/src/lib/notify.ts).
pub fn show<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.eval("window.dispatchEvent(new Event('caprock:shown'))");
    }
    #[cfg(target_os = "macos")]
    let _ = app.show();
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_parses_and_is_canonical() {
        assert_eq!(parse(DEFAULT).unwrap().into_string(), DEFAULT);
    }

    #[test]
    fn a_shortcut_from_the_settings_field_is_canonicalised() {
        let s = parse("Control+Alt+Super+KeyK").unwrap();
        assert_eq!(s.into_string(), "control+alt+super+KeyK");
        assert_eq!(
            parse("Alt+Super+Space").unwrap().into_string(),
            "alt+super+Space"
        );
    }

    #[test]
    fn a_shortcut_that_would_take_a_typed_key_is_refused() {
        for bad in ["KeyC", "Shift+KeyC", "", "Control+Alt", "Control+Nope"] {
            assert!(parse(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_choice_is_kept_and_off_is_remembered() {
        let dir = std::env::temp_dir().join(format!("caprock-hotkey-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let hk = Hotkey::new(&dir);
        assert_eq!(hk.saved().as_deref(), Some(DEFAULT), "no file: the default");
        hk.save(&None).unwrap();
        assert_eq!(hk.saved(), None, "off stays off");
        hk.save(&Some("alt+super+KeyK".into())).unwrap();
        assert_eq!(hk.saved().as_deref(), Some("alt+super+KeyK"));
        let st = hk.set(Some("alt+super+KeyK".into()), Some("taken".into()));
        assert!(!st.registered);
        let _ = std::fs::remove_dir_all(dir);
    }
}
