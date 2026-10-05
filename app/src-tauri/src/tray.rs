//! The menu bar item (macOS) or tray icon (F08): plan limits, today's spend
//! and the sessions waiting on you, each a click from its session. The page
//! sends what to show (`set_tray`), formatted by the same code as the
//! dashboard, so the two never disagree; the shell only draws it.

use crate::hotkey;
use crate::shell::MAIN;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::image::Image;
use tauri::menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Runtime};

const ID: &str = "caprock";
const SHOW: &str = "show";
const QUIT: &str = "quit";
const OPEN: &str = "open:";
const MAX_LINES: usize = 8;
const MAX_WAITING: usize = 10;
const MAX_CHARS: usize = 80;

/// One session waiting on you: its id and the row's label.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Waiting {
    pub id: String,
    pub label: String,
}

/// What the tray shows, as the page computed it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct View {
    /// Next to the icon in the macOS menu bar (and Linux indicators).
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub tooltip: String,
    /// Read-only rows: limits, today's spend, connection.
    #[serde(default)]
    pub lines: Vec<String>,
    #[serde(default)]
    pub waiting: Vec<Waiting>,
}

impl View {
    fn notice(line: &str) -> Self {
        Self {
            tooltip: "Caprock".into(),
            lines: vec![line.into()],
            ..Default::default()
        }
    }

    /// Bounded, whatever the page sent: a menu must fit on a screen.
    fn clamp(mut self) -> Self {
        let cut = |s: &mut String| {
            if s.chars().count() > MAX_CHARS {
                *s = s.chars().take(MAX_CHARS - 1).collect::<String>() + "…";
            }
        };
        self.lines.truncate(MAX_LINES);
        self.waiting.truncate(MAX_WAITING);
        self.lines.iter_mut().for_each(cut);
        self.waiting.iter_mut().for_each(|w| cut(&mut w.label));
        cut(&mut self.title);
        cut(&mut self.tooltip);
        self
    }
}

/// The last view drawn, so an unchanged frame does not rebuild the menu.
#[derive(Default)]
pub struct Tray(Mutex<Option<View>>);

pub fn install<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let view = View::notice("Connecting to the daemon…");
    let b = TrayIconBuilder::with_id(ID)
        .tooltip(&view.tooltip)
        .menu(&menu(app, &view)?)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| on_menu(app, event.id().as_ref()));
    #[cfg(target_os = "macos")]
    let b = b
        .icon(Image::from_bytes(include_bytes!("../icons/tray.png"))?)
        .icon_as_template(true);
    #[cfg(not(target_os = "macos"))]
    let b = match app.default_window_icon() {
        Some(icon) => b.icon(icon.clone()),
        None => b.icon(Image::from_bytes(include_bytes!("../icons/32x32.png"))?),
    };
    b.build(app)?;
    *app.state::<Tray>()
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = Some(view);
    Ok(())
}

/// Draws a view from the page. Unchanged views are skipped.
pub fn set<R: Runtime>(app: &AppHandle<R>, view: View) -> tauri::Result<()> {
    let view = view.clamp();
    let state = app.state::<Tray>();
    let mut last = state.0.lock().unwrap_or_else(|e| e.into_inner());
    if last.as_ref() == Some(&view) {
        return Ok(());
    }
    if let Some(tray) = app.tray_by_id(ID) {
        tray.set_menu(Some(menu(app, &view)?))?;
        tray.set_tooltip(Some(&view.tooltip))?;
        #[cfg(not(target_os = "windows"))]
        tray.set_title(Some(&view.title))?;
    }
    #[cfg(all(feature = "snapshot", target_os = "macos"))]
    crate::snapshot::record(
        "tray.json",
        serde_json::to_string(&view).unwrap_or_default(),
    );
    *last = Some(view);
    Ok(())
}

/// The daemon is gone and its page with it: say so and clear the badge, so
/// nothing stale is shown as current.
pub fn daemon_gone<R: Runtime>(app: &AppHandle<R>) {
    let _ = set(app, View::notice("The daemon is not running"));
    crate::badge::set(app, 0);
}

/// The rows of the menu, in order. `None` is a separator.
fn entries(view: &View) -> Vec<Option<(String, String, bool)>> {
    let mut out: Vec<Option<(String, String, bool)>> = Vec::new();
    for (i, l) in view.lines.iter().enumerate() {
        out.push(Some((format!("line:{i}"), l.clone(), false)));
    }
    out.push(None);
    if view.waiting.is_empty() {
        out.push(Some((
            "none".into(),
            "Nothing waiting on you".into(),
            false,
        )));
    } else {
        let head = format!("Waiting on you ({})", view.waiting.len());
        out.push(Some(("head".into(), head, false)));
        for w in &view.waiting {
            out.push(Some((format!("{OPEN}{}", w.id), w.label.clone(), true)));
        }
    }
    out.push(None);
    out.push(Some((SHOW.into(), "Show Caprock".into(), true)));
    out.push(Some((QUIT.into(), "Quit Caprock".into(), true)));
    out
}

fn menu<R: Runtime>(app: &AppHandle<R>, view: &View) -> tauri::Result<Menu<R>> {
    let menu = Menu::new(app)?;
    for e in entries(view) {
        let item: Box<dyn IsMenuItem<R>> = match e {
            None => Box::new(PredefinedMenuItem::separator(app)?),
            Some((id, text, enabled)) => {
                Box::new(MenuItem::with_id(app, id, text, enabled, None::<&str>)?)
            }
        };
        menu.append(item.as_ref())?;
    }
    Ok(menu)
}

fn on_menu<R: Runtime>(app: &AppHandle<R>, id: &str) {
    match id {
        SHOW => hotkey::show(app),
        QUIT => app.exit(0),
        _ => {
            if let Some(session) = id.strip_prefix(OPEN) {
                open_session(app, session);
            }
        }
    }
}

/// Brings the window up and asks the page to open the session (it listens
/// for `caprock:open-session`; app/README.md).
fn open_session<R: Runtime>(app: &AppHandle<R>, session: &str) {
    hotkey::show(app);
    let Some(w) = app.get_webview_window(MAIN) else {
        return;
    };
    let Ok(id) = serde_json::to_string(session) else {
        return;
    };
    let _ = w.eval(format!(
        "window.dispatchEvent(new CustomEvent('caprock:open-session', {{ detail: {id} }}))"
    ));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn waiting(n: usize) -> Vec<Waiting> {
        (0..n)
            .map(|i| Waiting {
                id: format!("s{i}"),
                label: format!("api · fix login {i}"),
            })
            .collect()
    }

    #[test]
    fn waiting_sessions_are_clickable_and_figures_are_not() {
        let v = View {
            lines: vec!["Claude 5h 42%".into(), "Today $3.10".into()],
            waiting: waiting(2),
            ..Default::default()
        };
        let e: Vec<_> = entries(&v).into_iter().flatten().collect();
        assert!(!e[0].2 && !e[1].2, "figures are read-only");
        assert_eq!(e[2].1, "Waiting on you (2)");
        assert_eq!((e[3].0.as_str(), e[3].2), ("open:s0", true));
        assert_eq!(e.last().unwrap().0, QUIT);
    }

    #[test]
    fn nothing_waiting_says_so() {
        let e = entries(&View::default());
        assert!(e.iter().flatten().any(|x| x.1 == "Nothing waiting on you"));
    }

    #[test]
    fn a_page_cannot_make_the_menu_endless() {
        let v = View {
            title: "x".repeat(500),
            lines: vec!["y".repeat(500); 30],
            waiting: waiting(40),
            ..Default::default()
        }
        .clamp();
        assert_eq!(v.lines.len(), MAX_LINES);
        assert_eq!(v.waiting.len(), MAX_WAITING);
        assert_eq!(v.title.chars().count(), MAX_CHARS);
        assert!(v.lines[0].ends_with('…'));
    }

    #[test]
    fn a_view_reads_the_page_payload() {
        let v: View = serde_json::from_value(serde_json::json!({
            "title": "42%", "lines": ["Today $1.00"],
            "waiting": [{"id": "abc", "label": "web · deploy"}]
        }))
        .unwrap();
        assert_eq!(v.waiting[0].id, "abc");
        assert_eq!(v.tooltip, "");
    }
}
