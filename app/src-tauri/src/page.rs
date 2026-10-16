//! A Page tab's web page (ADR-070): a native child webview of the main
//! window, laid over the tab's content area, which the dashboard places,
//! shows, hides and closes with the tab. A quick viewer, not a browser.
//!
//! The page is a stranger to Caprock. Its webview is labelled `page-<id>`,
//! and no capability names that label (capabilities/*.json grant by webview,
//! not window), so every command is refused to it; it gets no init script,
//! so no token and no `__CAPROCK_SHELL__`; and it runs in a non-persistent
//! data store of its own, so it shares no cookie or storage with the
//! dashboard or with another page, and leaves nothing on disk. It loads only
//! what the user asked for: the dashboard opens it on a click, and the shell
//! refuses any scheme but the web's. A download goes to the Downloads folder
//! and is never opened; a new window is handed back to the dashboard, which
//! opens it as another Page tab.

use crate::shell::MAIN;
use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::webview::{DownloadEvent, NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Runtime, Url, WebviewUrl};

/// Every page webview's label starts so; the dashboard's is `main`.
pub const PREFIX: &str = "page-";

/// What the dashboard hears about its pages (`ui/src/lib/pagetab.ts`).
pub const EVENT: &str = "caprock:page";

/// The tab's content area in the window, in logical pixels: the dashboard's
/// CSS rectangle times its zoom.
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
    /// Create it on `url` at `rect`, or show the one already there.
    Open {
        url: String,
        rect: Rect,
    },
    /// Move and size it with the tab.
    Place {
        rect: Rect,
    },
    Show,
    Hide,
    /// Gone: its process is freed (a closed tab, or one hidden long enough).
    Close,
    /// The address field: load `url` in it.
    Go {
        url: String,
    },
    Back,
    Forward,
    Reload,
}

/// The webview label for a tab's page id: letters, digits and dashes only.
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

/// A rectangle the window can hold: finite, at least a pixel each way.
pub fn sane(r: Rect) -> Option<Rect> {
    let ok = [r.x, r.y, r.width, r.height].iter().all(|v| v.is_finite());
    (ok && r.width >= 1.0 && r.height >= 1.0).then(|| Rect {
        x: r.x.max(0.0),
        y: r.y.max(0.0),
        ..r
    })
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

fn tell<R: Runtime>(app: &AppHandle<R>, detail: serde_json::Value) {
    if let Some(main) = app.get_webview(MAIN) {
        let _ = main.eval(event_script(&detail));
    }
}

/// Downloads in flight from pages: where each one is written, by URL.
#[derive(Default)]
pub struct Saving(Mutex<HashMap<String, PathBuf>>);

/// The one command a page tab needs, granted to the dashboard alone
/// (`allow-page-tab`). Async: on Windows, creating a webview from a
/// synchronous command deadlocks (Window::add_child).
#[tauri::command]
pub async fn page_tab<R: Runtime>(app: AppHandle<R>, id: String, act: Act) -> Result<(), String> {
    let label = label(&id).ok_or_else(|| format!("not a page id: {id}"))?;
    let page = app.get_webview(&label);
    match act {
        Act::Open { url, rect } => {
            let rect = sane(rect).ok_or("not a place in the window")?;
            if let Some(page) = page {
                place(&page, rect)?;
                return page.show().map_err(|e| e.to_string());
            }
            let url = web_url(&url)?;
            let window = app.get_window(MAIN).ok_or("no main window")?;
            window
                .add_child(
                    builder(&app, &id, &label, url),
                    LogicalPosition::new(rect.x, rect.y),
                    LogicalSize::new(rect.width, rect.height),
                )
                .map(|_| ())
                .map_err(|e| e.to_string())
        }
        act => {
            // A page closed while the dashboard was away: nothing to do.
            let Some(page) = page else { return Ok(()) };
            match act {
                Act::Place { rect } => place(&page, sane(rect).ok_or("not a place in the window")?),
                Act::Show => page.show().map_err(|e| e.to_string()),
                Act::Hide => page.hide().map_err(|e| e.to_string()),
                Act::Close => page.close().map_err(|e| e.to_string()),
                Act::Go { url } => page.navigate(web_url(&url)?).map_err(|e| e.to_string()),
                Act::Back => page.eval("history.back()").map_err(|e| e.to_string()),
                Act::Forward => page.eval("history.forward()").map_err(|e| e.to_string()),
                Act::Reload => page.reload().map_err(|e| e.to_string()),
                Act::Open { .. } => Ok(()),
            }
        }
    }
}

fn place<R: Runtime>(page: &tauri::Webview<R>, r: Rect) -> Result<(), String> {
    page.set_position(LogicalPosition::new(r.x, r.y))
        .and_then(|_| page.set_size(LogicalSize::new(r.width, r.height)))
        .map_err(|e| e.to_string())
}

fn builder<R: Runtime>(app: &AppHandle<R>, id: &str, label: &str, url: Url) -> WebviewBuilder<R> {
    let (nav, win, title, load) = (app.clone(), app.clone(), app.clone(), app.clone());
    let (id1, id2, id3, id4, id5) = (
        id.to_owned(),
        id.to_owned(),
        id.to_owned(),
        id.to_owned(),
        id.to_owned(),
    );
    WebviewBuilder::new(label, WebviewUrl::External(url))
        // Its own non-persistent store: no cookie shared with the dashboard
        // or another page, nothing kept on disk (WKWebsiteDataStore
        // nonPersistent, WebView2 InPrivate, WebKitGTK ephemeral).
        .incognito(true)
        // A file dropped on the page is the page's, as in a browser; the
        // window's drop handler (shell.rs) types paths into terminals only.
        .disable_drag_drop_handler()
        .on_navigation(move |url| {
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
            // Never a popup: the dashboard opens it as another Page tab.
            if matches!(url.scheme(), "http" | "https") {
                tell(&win, serde_json::json!({ "id": id2, "open": url.as_str() }));
            }
            NewWindowResponse::Deny
        })
        .on_document_title_changed(move |_, t| {
            tell(&title, serde_json::json!({ "id": id3, "title": t }));
        })
        .on_page_load(move |_, p| {
            let loading = matches!(p.event(), PageLoadEvent::Started);
            tell(
                &load,
                serde_json::json!({ "id": id4, "url": p.url().as_str(), "loading": loading }),
            );
        })
        .on_download(move |page, event| save(page, event, &id5))
}

/// A page's download, straight into the Downloads folder under a free name;
/// it is never opened. The dashboard says where it went.
fn save<R: Runtime>(page: tauri::Webview<R>, event: DownloadEvent<'_>, id: &str) -> bool {
    let app = page.app_handle();
    let saving = app.state::<Saving>();
    let mut map = saving.0.lock().unwrap_or_else(|e| e.into_inner());
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

/// Every page goes when the dashboard loads a page of its own (a reload, a
/// daemon swap, the fallback page): the tabs that come back open their
/// pages again only on a click.
pub fn close_all<R: Runtime>(app: &AppHandle<R>) {
    for (label, w) in app.webviews() {
        if label.starts_with(PREFIX) {
            let _ = w.close();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_page_id_is_letters_digits_and_dashes() {
        assert_eq!(label("p-lx2a-3").as_deref(), Some("page-p-lx2a-3"));
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
        ] {
            assert!(!may_navigate(&no.parse().unwrap()), "{no}");
        }
    }

    #[test]
    fn a_place_must_be_in_the_window() {
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
    }

    #[test]
    fn a_download_never_overwrites_a_file() {
        let dir = std::env::temp_dir().join(format!("caprock-page-dl-{}", std::process::id()));
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
        assert!(js.starts_with("window.dispatchEvent(new CustomEvent('caprock:page'"));
        assert!(js.contains(r#""title":"a'b</script>""#));
    }

    #[test]
    fn the_acts_read_as_the_dashboard_sends_them() {
        let a: Act = serde_json::from_value(serde_json::json!({"do": "open", "url": "https://a.b/", "rect": {"x": 1, "y": 2, "width": 3, "height": 4}})).unwrap();
        assert!(matches!(a, Act::Open { .. }));
        let a: Act = serde_json::from_value(serde_json::json!({"do": "hide"})).unwrap();
        assert!(matches!(a, Act::Hide));
        assert!(
            serde_json::from_value::<Act>(serde_json::json!({"do": "eval", "js": "x"})).is_err()
        );
    }
}
