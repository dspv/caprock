//! The in-app browser (beta, ADR-075): a browser tab's web page, in a window
//! of its own that the shell lays over the tab's content box in the main
//! window. The dashboard places, shows, hides and closes it with the tab.
//!
//! Not a child webview. 0.123.0's Page tab (ADR-070) put the page in a
//! child webview of the main window, behind Tauri's `unstable` feature; on
//! macOS 27 the app crashed twice and drops stopped arriving. A window of
//! its own leaves the main window exactly as it is without a browser: one
//! webview, found by `get_webview_window`, its drops heard where they always
//! were (shell.rs `listen_for_drops`). On macOS the page's window is a child
//! window of the main one (`addChildWindow`), so it moves with it; elsewhere
//! an owned (Windows) or transient (Linux) window the shell moves itself.
//!
//! The crash itself (ADR-075 § Root cause): a WebContent process asked the
//! UI process about the pasteboard for a page the UI process no longer knew
//! — one just closed — and WebKit killed it, then faulted cleaning up after
//! it. So a page is never closed while it is busy: it is hidden, sent to
//! `about:blank`, and closed only after its process has had time to settle
//! (`DRAIN`). Nothing closes a page on a timer; a page is closed only with
//! its tab, when the in-app browser is turned off, or when a reloaded
//! dashboard no longer has its tab.
//!
//! The page is a stranger to Caprock. Its window is labelled `browser-<id>`
//! and no capability names that label (capabilities/*.json grant by window),
//! so every command is refused to it. Its one script reads the browser keys
//! (KEYS_SCRIPT) and has no way to call the shell but a refused navigation.
//! It runs in a non-persistent data store of its own, so it shares no cookie
//! or storage with the dashboard or another page and leaves nothing on disk.
//! It loads only what the user asked for, follows only the web's schemes,
//! opens a new window as another browser tab, and downloads into Downloads
//! without opening the file.

use crate::shell::MAIN;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::webview::{DownloadEvent, NewWindowResponse, PageLoadEvent};
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, Runtime, Url, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

/// Every page window's label starts so; the dashboard's is `main`.
pub const PREFIX: &str = "browser-";

/// What the dashboard hears about its pages (`ui/src/lib/browsertab.ts`).
pub const EVENT: &str = "caprock:browser";

/// The scheme the page's key script navigates to; never followed (`key_of`).
pub const KEY_SCHEME: &str = "caprock-browser";

/// How long a closed page's process is left to settle on `about:blank`
/// before its window goes (the root cause in the module's doc).
pub const DRAIN: Duration = Duration::from_millis(1500);

/// Runs in the page before its own scripts, in its top frame only. It reads
/// the browser tab's keys — `browserKey` in ui/src/lib/browsertab.ts, kept
/// in step by hand — and hands each to the shell as a navigation to
/// `caprock-browser:<key>`, which the shell refuses and passes on. Nothing
/// else: the page learns nothing and can call nothing. A page that fakes
/// one can only move the user to the next tab or the address box.
pub const KEYS_SCRIPT: &str = r#"(() => {
  if (window.top !== window) return;
  const mac = navigator.platform.startsWith('Mac');
  const field = (t) => !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ''));
  addEventListener('keydown', (e) => {
    let k = null;
    if (mac) {
      if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        if (!field(e.target)) k = e.key === 'ArrowLeft' ? 'prev' : 'next';
      } else if (e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey && e.code === 'KeyL') k = 'address';
    } else if (e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
      if (e.key === 'PageUp') k = 'prev';
      else if (e.key === 'PageDown') k = 'next';
      else if (e.code === 'KeyL') k = 'address';
    }
    if (!k) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    location.href = 'caprock-browser:' + k;
  }, true);
})();"#;

/// The tab's content box in the main window, in logical pixels: the
/// dashboard's CSS rectangle times its zoom.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// What the dashboard asks of a page.
#[derive(Debug, Deserialize)]
#[serde(tag = "do", rename_all = "lowercase")]
pub enum Act {
    /// Create it on `url` over `rect`, or show the one already there.
    Open {
        url: String,
        rect: Rect,
        #[serde(default)]
        focus: bool,
    },
    /// Move and size it with the tab.
    Place {
        rect: Rect,
    },
    Show,
    Hide,
    /// Gone with its tab: drained, then closed (`DRAIN`).
    Close,
    /// The address box: load `url` in it.
    Go {
        url: String,
    },
    Back,
    Forward,
    Reload,
    /// Give it the keyboard.
    Focus,
    /// Pause what plays in it: an agent is waiting on the user.
    Pause,
    /// Close every page but these ids: the tabs a reloaded dashboard still has.
    Retain {
        ids: Vec<String>,
    },
}

/// The window label for a tab's page id: letters, digits and dashes only.
pub fn label(id: &str) -> Option<String> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    ok.then(|| format!("{PREFIX}{id}"))
}

/// A URL a page may load: http or https with a host. Anything else — file:,
/// javascript:, a scheme that launches an app — is refused.
pub fn web_url(raw: &str) -> Result<Url, String> {
    let url: Url = raw
        .trim()
        .parse()
        .map_err(|_| format!("not a web address: {raw}"))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none_or(str::is_empty) {
        return Err(format!("only http and https pages open in a tab: {raw}"));
    }
    Ok(url)
}

/// Whether a navigation inside a page may go ahead: the web's own schemes
/// (and the blank, data and blob documents pages make for themselves).
/// A link to another app's scheme is not followed.
pub fn may_navigate(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https" | "about" | "data" | "blob")
}

/// The browser key a navigation from KEYS_SCRIPT stands for, if it is one.
pub fn key_of(url: &Url) -> Option<&'static str> {
    if url.scheme() != KEY_SCHEME {
        return None;
    }
    match url.path() {
        "prev" => Some("prev"),
        "next" => Some("next"),
        "address" => Some("address"),
        _ => None,
    }
}

/// A rectangle the window can hold: finite, at least a pixel each way.
pub fn sane(r: Rect) -> Option<Rect> {
    let ok = [r.x, r.y, r.width, r.height].iter().all(|v| v.is_finite());
    (ok && r.width >= 1.0 && r.height >= 1.0).then(|| Rect {
        x: r.x.max(0.0),
        y: r.y.max(0.0),
        ..r
    })
}

/// Where the page's window goes on screen: the main window's content
/// origin (logical) plus the box.
pub fn on_screen(origin: (f64, f64), r: Rect) -> (f64, f64) {
    (origin.0 + r.x, origin.1 + r.y)
}

/// `name` in `dir`, or `name (1)`, `name (2)` … when it is taken.
pub fn unique_in(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let p = Path::new(name);
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or(name);
    let ext = p.extension().and_then(|s| s.to_str());
    (1..10_000)
        .map(|n| match ext {
            Some(e) => dir.join(format!("{stem} ({n}).{e}")),
            None => dir.join(format!("{stem} ({n})")),
        })
        .find(|c| !c.exists())
        .unwrap_or(first)
}

/// The script that hands `detail` to the dashboard.
pub fn event_script(detail: &serde_json::Value) -> String {
    format!("window.dispatchEvent(new CustomEvent('{EVENT}', {{ detail: {detail} }}))")
}

/// What `Pause` runs in the page: every video and audio element stops.
pub const PAUSE_SCRIPT: &str =
    "document.querySelectorAll('video,audio').forEach((m) => { try { m.pause() } catch (e) {} })";

fn tell<R: Runtime>(app: &AppHandle<R>, detail: serde_json::Value) {
    if let Some(main) = app.get_webview_window(MAIN) {
        let _ = main.eval(event_script(&detail));
    }
}

/// The pages' places and downloads.
#[derive(Default)]
pub struct Pages {
    /// The last box each page was placed over, by label: the main window
    /// moved or resized, the shown ones follow it.
    rects: Mutex<HashMap<String, Rect>>,
    /// Downloads in flight: where each one is written, by URL.
    saving: Mutex<HashMap<String, PathBuf>>,
}

/// The main window's move and resize events are followed once.
static FOLLOWING: AtomicBool = AtomicBool::new(false);

/// The one command a browser tab needs, granted to the dashboard alone
/// (`allow-browser-tab`). Async: on Windows, creating a window from a
/// synchronous command deadlocks.
#[tauri::command]
pub async fn browser_tab<R: Runtime>(
    app: AppHandle<R>,
    id: String,
    act: Act,
) -> Result<(), String> {
    if let Act::Retain { ids } = &act {
        retain(&app, ids);
        return Ok(());
    }
    let label = label(&id).ok_or_else(|| format!("not a page id: {id}"))?;
    let page = app.get_webview_window(&label);
    match act {
        Act::Open { url, rect, focus } => {
            let rect = sane(rect).ok_or("not a place in the window")?;
            let page = match page {
                Some(p) => p,
                None => build(&app, &id, &label, web_url(&url)?)?,
            };
            follow_main(&app);
            place(&app, &label, &page, rect)?;
            page.show().map_err(|e| e.to_string())?;
            if focus {
                let _ = page.set_focus();
            }
            Ok(())
        }
        act => {
            // A page closed while the dashboard was away: nothing to do.
            let Some(page) = page else { return Ok(()) };
            match act {
                Act::Place { rect } => place(
                    &app,
                    &label,
                    &page,
                    sane(rect).ok_or("not a place in the window")?,
                ),
                Act::Show => page.show().map_err(|e| e.to_string()),
                Act::Hide => page.hide().map_err(|e| e.to_string()),
                Act::Close => {
                    drain(&app, &label, page);
                    Ok(())
                }
                Act::Go { url } => page.navigate(web_url(&url)?).map_err(|e| e.to_string()),
                Act::Back => page.eval("history.back()").map_err(|e| e.to_string()),
                Act::Forward => page.eval("history.forward()").map_err(|e| e.to_string()),
                Act::Reload => page.reload().map_err(|e| e.to_string()),
                Act::Focus => page.set_focus().map_err(|e| e.to_string()),
                Act::Pause => page.eval(PAUSE_SCRIPT).map_err(|e| e.to_string()),
                Act::Open { .. } | Act::Retain { .. } => Ok(()),
            }
        }
    }
}

/// Puts the page's window over the box, in screen coordinates.
fn place<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    page: &WebviewWindow<R>,
    r: Rect,
) -> Result<(), String> {
    let main = app.get_webview_window(MAIN).ok_or("no main window")?;
    let scale = main.scale_factor().map_err(|e| e.to_string())?;
    let origin = main
        .inner_position()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(scale);
    let (x, y) = on_screen((origin.x, origin.y), r);
    page.set_size(LogicalSize::new(r.width, r.height))
        .and_then(|_| page.set_position(LogicalPosition::new(x, y)))
        .map_err(|e| e.to_string())?;
    if let Some(p) = app.try_state::<Pages>() {
        p.rects
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(label.to_owned(), r);
    }
    Ok(())
}

/// The main window moved, resized or changed screens: every shown page
/// follows it. On macOS a child window already moves with its parent; this
/// keeps a resize and the other systems right.
fn follow_main<R: Runtime>(app: &AppHandle<R>) {
    if FOLLOWING.swap(true, Ordering::Relaxed) {
        return;
    }
    let Some(main) = app.get_webview_window(MAIN) else {
        FOLLOWING.store(false, Ordering::Relaxed);
        return;
    };
    let app = app.clone();
    main.on_window_event(move |e| {
        if !matches!(
            e,
            tauri::WindowEvent::Moved(_)
                | tauri::WindowEvent::Resized(_)
                | tauri::WindowEvent::ScaleFactorChanged { .. }
        ) {
            return;
        }
        let Some(pages) = app.try_state::<Pages>() else {
            return;
        };
        let rects: Vec<(String, Rect)> = pages
            .rects
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .map(|(l, r)| (l.clone(), *r))
            .collect();
        for (label, r) in rects {
            if let Some(w) = app.get_webview_window(&label) {
                if w.is_visible().unwrap_or(false) {
                    let _ = place(&app, &label, &w, r);
                }
            }
        }
    });
}

/// Closes a page without racing its own process: hidden at once, sent to
/// `about:blank`, closed `DRAIN` later.
fn drain<R: Runtime>(app: &AppHandle<R>, label: &str, page: WebviewWindow<R>) {
    let _ = page.hide();
    if let Some(p) = app.try_state::<Pages>() {
        p.rects
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(label);
    }
    if let Ok(blank) = "about:blank".parse() {
        let _ = page.navigate(blank);
    }
    std::thread::spawn(move || {
        std::thread::sleep(DRAIN);
        let _ = page.close();
    });
}

/// Every page whose id is not in `ids` is closed (drained).
fn retain<R: Runtime>(app: &AppHandle<R>, ids: &[String]) {
    let keep: HashSet<String> = ids.iter().filter_map(|i| label(i)).collect();
    for (l, w) in app.webview_windows() {
        if l.starts_with(PREFIX) && !keep.contains(&l) {
            drain(app, &l, w);
        }
    }
}

/// Every page is hidden: the dashboard is loading a page of its own (a
/// reload, a daemon swap, the fallback page). The tabs that come back show
/// their pages again; the rest are closed by the dashboard's `Retain`.
pub fn hide_all<R: Runtime>(app: &AppHandle<R>) {
    for (l, w) in app.webview_windows() {
        if l.starts_with(PREFIX) {
            let _ = w.hide();
        }
    }
}

fn build<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    label: &str,
    url: Url,
) -> Result<WebviewWindow<R>, String> {
    let (nav, win, title, load) = (app.clone(), app.clone(), app.clone(), app.clone());
    let (id1, id2, id3, id4, id5) = (
        id.to_owned(),
        id.to_owned(),
        id.to_owned(),
        id.to_owned(),
        id.to_owned(),
    );
    let main = app.get_webview_window(MAIN).ok_or("no main window")?;
    let b = WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
        .title("Caprock browser tab")
        // Drawn by the dashboard: the tab, the toolbar and the frame are
        // the main window's; this window is the page alone.
        .decorations(false)
        .resizable(false)
        .shadow(false)
        .skip_taskbar(true)
        .visible(false)
        .focused(false)
        .accept_first_mouse(true)
        // Its own non-persistent store: no cookie shared with the dashboard
        // or another page, nothing kept on disk (WKWebsiteDataStore
        // nonPersistent, WebView2 InPrivate, WebKitGTK ephemeral).
        .incognito(true)
        // A file dropped on the page is the page's, as in a browser. The
        // main window's own drop handler (shell.rs) is untouched, so a file
        // dropped on a terminal still types its path there.
        .disable_drag_drop_handler()
        .initialization_script(KEYS_SCRIPT)
        .on_navigation(move |url| {
            if let Some(k) = key_of(url) {
                // The keyboard goes back to the dashboard, which acts on the key.
                focus_main(&nav);
                tell(&nav, serde_json::json!({ "id": id1, "key": k }));
                return false;
            }
            let ok = may_navigate(url);
            if !ok {
                tell(
                    &nav,
                    serde_json::json!({ "id": id1, "refused": url.as_str() }),
                );
            }
            ok
        })
        .on_new_window(move |url, _| {
            // Never a popup: the dashboard opens it as another browser tab.
            if matches!(url.scheme(), "http" | "https") {
                tell(&win, serde_json::json!({ "id": id2, "open": url.as_str() }));
            }
            NewWindowResponse::Deny
        })
        .on_document_title_changed(move |_, t| {
            tell(&title, serde_json::json!({ "id": id3, "title": t }));
        })
        .on_page_load(move |_, p| {
            // The drain's own blank page is nobody's news.
            if p.url().scheme() == "about" {
                return;
            }
            let loading = matches!(p.event(), PageLoadEvent::Started);
            tell(
                &load,
                serde_json::json!({ "id": id4, "url": p.url().as_str(), "loading": loading }),
            );
        })
        .on_download(move |page, event| save(page, event, &id5));
    // macOS: a child window (moves with the main one, stays above it);
    // Windows: owned; Linux: transient for it.
    let b = b.parent(&main).map_err(|e| e.to_string())?;
    b.build().map_err(|e| e.to_string())
}

/// A key from the page moves the keyboard back to the dashboard, which
/// acts on it there.
fn focus_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(m) = app.get_webview_window(MAIN) {
        let _ = m.set_focus();
    }
}

/// A page's download, straight into the Downloads folder under a free name;
/// it is never opened. The dashboard says where it went.
fn save<R: Runtime>(page: tauri::Webview<R>, event: DownloadEvent<'_>, id: &str) -> bool {
    let app = page.app_handle();
    let Some(pages) = app.try_state::<Pages>() else {
        return false;
    };
    let mut map = pages.saving.lock().unwrap_or_else(|e| e.into_inner());
    match event {
        DownloadEvent::Requested { url, destination } => {
            let Some(dir) = dirs::download_dir() else {
                return false;
            };
            let name = destination
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .filter(|n| !n.is_empty())
                .unwrap_or_else(|| "download".into());
            let to = unique_in(&dir, &name);
            *destination = to.clone();
            map.insert(url.to_string(), to);
            true
        }
        DownloadEvent::Finished { url, success, .. } => {
            let to = map.remove(url.as_str());
            drop(map);
            let name = to
                .as_deref()
                .and_then(Path::file_name)
                .map(|n| n.to_string_lossy().into_owned());
            tell(
                app,
                serde_json::json!({ "id": id, "saved": name, "ok": success }),
            );
            true
        }
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_page_id_is_letters_digits_and_dashes() {
        assert_eq!(label("lx2a-3").as_deref(), Some("browser-lx2a-3"));
        for bad in ["", "a/b", "../main", "x y", "main:1", &"a".repeat(65)] {
            assert_eq!(label(bad), None, "{bad}");
        }
    }

    #[test]
    fn only_web_addresses_open() {
        assert!(web_url("https://example.com/").is_ok());
        assert!(web_url(" http://localhost:5173/ ").is_ok());
        for bad in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "vscode://open",
            "mailto:a@b.c",
            "localhost:5173",
            "about:blank",
            "caprock-browser:next",
            "",
        ] {
            assert!(web_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_page_never_follows_a_link_into_another_app() {
        for ok in [
            "https://a.b/",
            "http://127.0.0.1:3000/",
            "about:blank",
            "blob:https://a.b/x",
        ] {
            assert!(may_navigate(&ok.parse().unwrap()), "{ok}");
        }
        for no in [
            "file:///etc/hosts",
            "zoommtg://x",
            "mailto:a@b.c",
            "tauri://localhost/",
            "caprock-browser:next",
        ] {
            assert!(!may_navigate(&no.parse().unwrap()), "{no}");
        }
    }

    #[test]
    fn the_key_script_speaks_only_three_words() {
        for (u, k) in [
            ("caprock-browser:prev", Some("prev")),
            ("caprock-browser:next", Some("next")),
            ("caprock-browser:address", Some("address")),
            ("caprock-browser:eval", None),
            ("https://prev/", None),
        ] {
            assert_eq!(key_of(&u.parse().unwrap()), k, "{u}");
        }
        // The script and ui/src/lib/browsertab.ts browserKey read the same keys.
        for needle in [
            "'ArrowLeft'",
            "'ArrowRight'",
            "'PageUp'",
            "'PageDown'",
            "'KeyL'",
            "field(e.target)",
            "caprock-browser:",
            "window.top !== window",
        ] {
            assert!(KEYS_SCRIPT.contains(needle), "{needle}");
        }
    }

    #[test]
    fn a_place_must_be_in_the_window_and_lands_on_screen_beside_it() {
        let r = |x, y, width, height| Rect {
            x,
            y,
            width,
            height,
        };
        assert_eq!(
            sane(r(-3.0, 40.0, 800.0, 600.0)),
            Some(r(0.0, 40.0, 800.0, 600.0))
        );
        assert_eq!(sane(r(0.0, 0.0, 0.0, 600.0)), None);
        assert_eq!(sane(r(f64::NAN, 0.0, 10.0, 10.0)), None);
        assert_eq!(sane(r(0.0, 0.0, 10.0, f64::INFINITY)), None);
        assert_eq!(
            on_screen((100.0, 50.0), r(260.0, 72.0, 10.0, 10.0)),
            (360.0, 122.0)
        );
    }

    #[test]
    fn a_download_never_overwrites_a_file() {
        let dir = std::env::temp_dir().join(format!("caprock-browser-dl-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(unique_in(&dir, "a.pdf"), dir.join("a.pdf"));
        std::fs::write(dir.join("a.pdf"), b"x").unwrap();
        assert_eq!(unique_in(&dir, "a.pdf"), dir.join("a (1).pdf"));
        std::fs::write(dir.join("a (1).pdf"), b"x").unwrap();
        assert_eq!(unique_in(&dir, "a.pdf"), dir.join("a (2).pdf"));
        std::fs::write(dir.join("notes"), b"x").unwrap();
        assert_eq!(unique_in(&dir, "notes"), dir.join("notes (1)"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_dashboard_hears_a_page_as_one_event() {
        let js = event_script(&serde_json::json!({"id": "p1", "title": "a'b</script>"}));
        assert!(js.starts_with("window.dispatchEvent(new CustomEvent('caprock:browser'"));
        assert!(js.contains(r#""title":"a'b</script>""#));
    }

    #[test]
    fn the_acts_read_as_the_dashboard_sends_them() {
        let a: Act = serde_json::from_value(serde_json::json!({"do": "open", "url": "https://a.b/", "rect": {"x": 1, "y": 2, "width": 3, "height": 4}, "focus": true})).unwrap();
        assert!(matches!(a, Act::Open { focus: true, .. }));
        let a: Act = serde_json::from_value(serde_json::json!({"do": "open", "url": "https://a.b/", "rect": {"x": 1, "y": 2, "width": 3, "height": 4}})).unwrap();
        assert!(matches!(a, Act::Open { focus: false, .. }));
        let a: Act = serde_json::from_value(serde_json::json!({"do": "hide"})).unwrap();
        assert!(matches!(a, Act::Hide));
        let a: Act =
            serde_json::from_value(serde_json::json!({"do": "retain", "ids": ["a", "b"]})).unwrap();
        assert!(matches!(a, Act::Retain { ids } if ids.len() == 2));
        assert!(
            serde_json::from_value::<Act>(serde_json::json!({"do": "eval", "js": "x"})).is_err()
        );
    }

    #[test]
    fn pausing_touches_only_media() {
        assert!(PAUSE_SCRIPT.contains("querySelectorAll('video,audio')"));
        assert!(!PAUSE_SCRIPT.contains("location"));
    }
}
