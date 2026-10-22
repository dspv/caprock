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
//! so every command is refused to it. Its scripts read the browser keys
//! (KEYS_SCRIPT) and, in phone mode, make a finger of the mouse
//! (TOUCH_SCRIPT); neither has a way to call the shell but a refused
//! navigation.
//!
//! Phone mode (ADR-075, amended 2026-10-21) is the dashboard's: it places
//! the page over a device's page area, so the window is that size, and
//! hands `open` the device's user agent and the touch script's state. The
//! agent is changed in place (WKWebView `customUserAgent`, WebView2
//! `Settings.UserAgent`, WebKitGTK `user-agent`) and the page reloaded, so
//! the page keeps its window, its store and its logins.
//!
//! Side by side (2026-10-22) is three such pages, one per phone, drawn
//! smaller than the phones: the dashboard names the page's CSS width and
//! the shell zooms the page out by window ÷ width (`zoom_for`; WKWebView
//! `pageZoom`, WebView2 `ZoomFactor`, WebKitGTK zoom level), so it still
//! lays out at the phone's width. `Measure` reads, through
//! `eval_with_callback`, whether the page's document is wider than that.
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
      else if (e.metaKey && e.altKey && !e.ctrlKey && !e.shiftKey && e.code === 'KeyR') k = 'phone';
    } else if (e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
      if (e.key === 'PageUp') k = 'prev';
      else if (e.key === 'PageDown') k = 'next';
      else if (e.code === 'KeyL') k = 'address';
    } else if (e.ctrlKey && e.altKey && e.shiftKey && !e.metaKey && e.code === 'KeyD') k = 'phone';
    if (!k) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    location.href = 'caprock-browser:' + k;
  }, true);
})();"#;

/// Phone mode's touch (ADR-075, amended 2026-10-21): runs in every page,
/// in its top frame, dormant until the shell turns it on
/// (`window.__caprockTouch(true)`, `touch_eval`). On, the mouse acts as one
/// finger: a press, a drag and a release reach the page as pointer events
/// of `pointerType: "touch"` aimed at the element first pressed (a finger's
/// implicit capture), the real mouse events are kept from the page, and a
/// drag past an 8 px slop over something that scrolls on that axis — and
/// whose `touch-action` lets it — becomes a scroll with momentum after a
/// `pointercancel`, as a browser does with a finger. A tap is still a click;
/// a drag is not. `navigator.maxTouchPoints` reads 5. Approximate by
/// design: there are no TouchEvents (macOS WebKit has none to make), CSS
/// :hover still applies, and the momentum is this script's, not the engine's.
/// A page starts with it on when its user agent is a phone's (` Mobile`, the
/// one phone mode sets), so a page reading `maxTouchPoints` as it loads
/// sees the phone; the shell corrects it once the page has loaded when
/// Touch is off (`touch_eval`).
pub const TOUCH_SCRIPT: &str = r#"(() => {
  if (window.top !== window) return;
  let on = /\bMobile\b/.test(navigator.userAgent);
  try {
    const own = Object.getOwnPropertyDescriptor(Navigator.prototype, 'maxTouchPoints');
    Object.defineProperty(Navigator.prototype, 'maxTouchPoints', { configurable: true, get() { return on ? 5 : (own && own.get ? own.get.call(this) : 0); } });
  } catch (e) {}
  let drag = null, raf = 0, eatClick = false;
  const SLOP = 8;
  const field = (t) => !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ''));
  const fire = (type, src, target) => {
    const up = type === 'pointerup' || type === 'pointercancel';
    try {
      target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: type !== 'pointercancel', composed: true, view: window,
        pointerId: src.pointerId, pointerType: 'touch', isPrimary: true, width: 20, height: 20, pressure: up ? 0 : 0.5,
        clientX: src.clientX, clientY: src.clientY, screenX: src.screenX, screenY: src.screenY,
        button: type === 'pointermove' ? -1 : 0, buttons: up ? 0 : 1 }));
    } catch (e) {}
  };
  const pans = (el, axis) => {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const ta = getComputedStyle(n).touchAction || 'auto';
      if (ta === 'none') return false;
      if (ta.includes('pan-') && !ta.includes('pan-' + axis) && !(axis === 'y' && /pan-(up|down)/.test(ta)) && !(axis === 'x' && /pan-(left|right)/.test(ta))) return false;
    }
    return true;
  };
  const scroller = (el, axis) => {
    const root = document.scrollingElement || document.documentElement;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (n === root || n === document.body) break;
      const s = getComputedStyle(n);
      const o = axis === 'y' ? s.overflowY : s.overflowX;
      const room = axis === 'y' ? n.scrollHeight > n.clientHeight : n.scrollWidth > n.clientWidth;
      if (room && /(auto|scroll|overlay)/.test(o)) return n;
    }
    return (axis === 'y' ? root.scrollHeight > root.clientHeight : root.scrollWidth > root.clientWidth) ? root : null;
  };
  const stop = (e) => { e.stopImmediatePropagation(); };
  addEventListener('pointerdown', (e) => {
    if (!on || e.pointerType !== 'mouse' || e.button !== 0) return;
    stop(e);
    cancelAnimationFrame(raf);
    eatClick = false;
    drag = { target: e.target, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, t: performance.now(), vx: 0, vy: 0, moved: false, pan: null, axis: null };
    fire('pointerdown', e, e.target);
  }, true);
  addEventListener('pointermove', (e) => {
    if (!on || e.pointerType !== 'mouse') return;
    stop(e);
    if (!drag) return;
    const now = performance.now(), dt = Math.max(8, now - drag.t);
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.vx = dx / dt * 16; drag.vy = dy / dt * 16;
    drag.x = e.clientX; drag.y = e.clientY; drag.t = now;
    if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) > SLOP) {
      drag.moved = true;
      eatClick = true;
      const axis = Math.abs(e.clientX - drag.x0) > Math.abs(e.clientY - drag.y0) ? 'x' : 'y';
      const sc = pans(drag.target, axis) ? scroller(drag.target, axis) : null;
      if (sc) { drag.pan = sc; drag.axis = axis; fire('pointercancel', e, drag.target); }
    }
    if (drag.pan) {
      if (drag.axis === 'y') drag.pan.scrollTop -= dy; else drag.pan.scrollLeft -= dx;
    } else fire('pointermove', e, drag.target);
  }, true);
  const end = (e) => {
    if (!on || e.pointerType !== 'mouse') return;
    stop(e);
    if (!drag) return;
    const d = drag;
    drag = null;
    if (!d.pan) { fire(e.type === 'pointercancel' ? 'pointercancel' : 'pointerup', e, d.target); return; }
    if (performance.now() - d.t > 80) return;
    let v = Math.max(-60, Math.min(60, d.axis === 'y' ? -d.vy : -d.vx));
    const step = () => {
      if (Math.abs(v) < 0.3) return;
      if (d.axis === 'y') d.pan.scrollTop += v; else d.pan.scrollLeft += v;
      v *= 0.95;
      raf = requestAnimationFrame(step);
    };
    step();
  };
  addEventListener('pointerup', end, true);
  addEventListener('pointercancel', end, true);
  for (const t of ['mousedown', 'mousemove', 'mouseup', 'mouseover', 'mouseout', 'mouseenter', 'mouseleave', 'pointerover', 'pointerout', 'pointerenter', 'pointerleave']) {
    addEventListener(t, (e) => {
      if (!on || (e.pointerType && e.pointerType !== 'mouse')) return;
      stop(e);
      if (t === 'mousedown' && !field(e.target)) e.preventDefault();
    }, true);
  }
  addEventListener('click', (e) => { if (on && eatClick) { eatClick = false; e.preventDefault(); stop(e); } }, true);
  addEventListener('dragstart', (e) => { if (on) e.preventDefault(); }, true);
  addEventListener('wheel', () => { cancelAnimationFrame(raf); }, { capture: true, passive: true });
  Object.defineProperty(window, '__caprockTouch', { value: (v) => { on = !!v; drag = null; eatClick = false; cancelAnimationFrame(raf); } });
})();"#;

/// What `Measure` evaluates in the page: its document's width and the width
/// it is laid out in, CSS px, as one string — `"640/375"`. It reads and
/// changes nothing; a page that fakes it only fakes its own *cut off* mark.
pub const MEASURE_SCRIPT: &str = "(() => { const d = document.documentElement; return d ? Math.ceil(d.scrollWidth) + '/' + Math.round(d.clientWidth) : '' })()";

/// `MEASURE_SCRIPT`'s answer as the shell hears it (a JSON string on every
/// system, or the bare text): the two widths, or None.
pub fn measured(raw: &str) -> Option<(u32, u32)> {
    let t = raw.trim().trim_matches('"');
    let (a, b) = t.split_once('/')?;
    Some((a.trim().parse().ok()?, b.trim().parse().ok()?))
}

/// The zoom that lays a page of CSS width `page` out in a window `window`
/// logical px wide: 1 unless the window is narrower (side by side draws the
/// phones smaller), never below a tenth.
pub fn zoom_for(window: f64, page: Option<f64>) -> f64 {
    match page {
        Some(p) if p.is_finite() && p >= 1.0 && window.is_finite() && window < p - 0.5 => {
            (window / p).clamp(0.1, 1.0)
        }
        _ => 1.0,
    }
}

/// What turns a live page's touch on or off (TOUCH_SCRIPT).
pub fn touch_eval(on: bool) -> String {
    format!("window.__caprockTouch && window.__caprockTouch({on})")
}

/// A user agent the dashboard may set for phone mode: printable ASCII, at
/// most 512 characters, not empty.
pub fn user_agent(raw: &str) -> Option<String> {
    let ua = raw.trim();
    let ok = !ua.is_empty() && ua.len() <= 512 && ua.chars().all(|c| (' '..='~').contains(&c));
    ok.then(|| ua.to_owned())
}

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
        /// Phone mode: the device's user agent and the touch script's
        /// state. Absent, the page is a desktop page again.
        #[serde(default)]
        phone: Option<Phone>,
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
    /// Side by side: is its document wider than its window? Told back as
    /// `{id, doc, view}` (`MEASURE_SCRIPT`).
    Measure,
    /// Close every page but these ids: the tabs a reloaded dashboard still has.
    Retain {
        ids: Vec<String>,
    },
}

/// Phone mode as the dashboard asks for it (ui/src/lib/phonemode.ts
/// `PhoneSpec`). The size is the `rect`'s: the dashboard places the page
/// over the device's page area.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct Phone {
    pub ua: String,
    #[serde(default)]
    pub touch: bool,
    /// Side by side: the page's CSS width; the window is smaller, so the
    /// page is zoomed out to lay out at it (`zoom_for`). Absent, no zoom.
    #[serde(default)]
    pub width: Option<f64>,
}

/// What a page window is set to now: the user agent phone mode gave it
/// (None: the webview's own) and whether its touch script is on.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Mode {
    pub ua: Option<String>,
    pub touch: bool,
}

/// What a page must change to go from `was` to the mode `phone` asks for:
/// a new user agent (Some(None) back to the webview's own), and the touch
/// script's new state. A new user agent reloads the page, so what the
/// server and the page's first scripts read is the phone's.
pub fn change(was: &Mode, phone: Option<&Phone>) -> (Mode, Option<Option<String>>, Option<bool>) {
    let next = match phone {
        Some(p) => Mode {
            ua: user_agent(&p.ua),
            touch: p.touch,
        },
        None => Mode::default(),
    };
    let ua = (next.ua != was.ua).then(|| next.ua.clone());
    let touch = (next.touch != was.touch).then_some(next.touch);
    (next, ua, touch)
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
        "phone" => Some("phone"),
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
    /// Phone mode, by label: the pages a device's user agent or touch was
    /// given to. Absent, a desktop page.
    modes: Mutex<HashMap<String, Mode>>,
    /// Windows: each page's own user agent, read before phone mode first
    /// replaced it, to give it back (WebView2 has no "reset").
    own_ua: Mutex<HashMap<String, String>>,
    /// Side by side, by label: the page's CSS width (`Phone::width`) and the
    /// zoom last given for it. Absent, 1.
    widths: Mutex<HashMap<String, f64>>,
    zooms: Mutex<HashMap<String, f64>>,
}

impl Pages {
    fn width(&self, label: &str) -> Option<f64> {
        self.widths
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(label)
            .copied()
    }

    fn zoom(&self, label: &str) -> f64 {
        self.zooms
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(label)
            .copied()
            .unwrap_or(1.0)
    }

    fn mode(&self, label: &str) -> Mode {
        self.modes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(label)
            .cloned()
            .unwrap_or_default()
    }
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
        Act::Open {
            url,
            rect,
            focus,
            phone,
        } => {
            let rect = sane(rect).ok_or("not a place in the window")?;
            if let Some(pages) = app.try_state::<Pages>() {
                let mut w = pages.widths.lock().unwrap_or_else(|e| e.into_inner());
                match phone.as_ref().and_then(|p| p.width) {
                    Some(px) => w.insert(label.clone(), px),
                    None => w.remove(&label),
                };
            }
            let page = match page {
                Some(p) => {
                    set_mode(&app, &label, &p, phone.as_ref(), true);
                    p
                }
                None if phone.is_some() => {
                    // A phone's first request already carries its user
                    // agent: the window starts blank, takes the device's
                    // agent, then goes to the address.
                    let to = web_url(&url)?;
                    let blank = "about:blank".parse().map_err(|_| "about:blank")?;
                    let p = build(&app, &id, &label, blank)?;
                    set_mode(&app, &label, &p, phone.as_ref(), false);
                    p.navigate(to).map_err(|e| e.to_string())?;
                    p
                }
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
                Act::Measure => {
                    let (to, id) = (app.clone(), id.clone());
                    page.eval_with_callback(MEASURE_SCRIPT, move |raw| {
                        if let Some((doc, view)) = measured(&raw) {
                            tell(
                                &to,
                                serde_json::json!({ "id": id, "doc": doc, "view": view }),
                            );
                        }
                    })
                    .map_err(|e| e.to_string())
                }
                Act::Open { .. } | Act::Retain { .. } => Ok(()),
            }
        }
    }
}

/// Gives the page the mode `phone` asks for: the device's user agent (the
/// page reloads when `reload`, so the server and its first scripts see the
/// phone) and its touch on or off. Nothing happens when nothing changed.
fn set_mode<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    page: &WebviewWindow<R>,
    phone: Option<&Phone>,
    reload: bool,
) {
    let Some(pages) = app.try_state::<Pages>() else {
        return;
    };
    let (next, ua, touch) = change(&pages.mode(label), phone);
    {
        let mut modes = pages.modes.lock().unwrap_or_else(|e| e.into_inner());
        if next == Mode::default() {
            modes.remove(label);
        } else {
            modes.insert(label.to_owned(), next);
        }
    }
    if let Some(ua) = ua {
        set_user_agent(page, ua);
        if reload {
            // The touch script's state comes back on the load (`build`).
            let _ = page.reload();
            return;
        }
    }
    if let Some(on) = touch {
        let _ = page.eval(touch_eval(on));
    }
}

/// The page's user agent: the device's, or None for the webview's own. On
/// the main thread (`with_webview`), before anything queued after it.
fn set_user_agent<R: Runtime>(page: &WebviewWindow<R>, ua: Option<String>) {
    #[cfg(target_os = "macos")]
    let _ = page.with_webview(move |pw| {
        use objc2::msg_send;
        use objc2::runtime::AnyObject;
        use objc2_foundation::NSString;
        let wk = pw.inner() as *mut AnyObject;
        if wk.is_null() {
            return;
        }
        let s = ua.as_deref().map(NSString::from_str);
        // SAFETY: `wk` is this window's live WKWebView, on the main thread;
        // a nil customUserAgent is WebKit's own again.
        unsafe {
            let _: () = msg_send![wk, setCustomUserAgent: s.as_deref()];
        }
    });
    #[cfg(windows)]
    {
        let app = page.app_handle().clone();
        let label = page.label().to_owned();
        let _ = page.with_webview(move |pw| {
            let _ = win_user_agent(&app, &label, &pw, ua);
        });
    }
    #[cfg(target_os = "linux")]
    let _ = page.with_webview(move |pw| {
        use webkit2gtk::{SettingsExt, WebViewExt};
        if let Some(s) = pw.inner().settings() {
            // None: WebKitGTK's own user agent again.
            s.set_user_agent(ua.as_deref());
        }
    });
    #[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
    let _ = (page, ua);
}

#[cfg(windows)]
fn win_user_agent<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    pw: &tauri::webview::PlatformWebview,
    ua: Option<String>,
) -> windows::core::Result<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings2;
    use windows::core::{Interface, HSTRING, PCWSTR, PWSTR};
    // SAFETY: COM calls on the webview's own thread (with_webview).
    unsafe {
        let settings: ICoreWebView2Settings2 =
            pw.controller().CoreWebView2()?.Settings()?.cast()?;
        let own = match app.try_state::<Pages>() {
            Some(pages) => {
                let mut map = pages.own_ua.lock().unwrap_or_else(|e| e.into_inner());
                if !map.contains_key(label) {
                    let mut p = PWSTR::null();
                    settings.UserAgent(&mut p)?;
                    map.insert(label.to_owned(), webview2_com::take_pwstr(p));
                }
                map.get(label).cloned()
            }
            None => None,
        };
        let Some(to) = ua.or(own) else { return Ok(()) };
        let h = HSTRING::from(to);
        settings.SetUserAgent(PCWSTR(h.as_ptr()))
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
        // Side by side: zoomed so the page lays out at the phone's width.
        let want = zoom_for(r.width, p.width(label));
        if (want - p.zoom(label)).abs() > 1e-3 && page.set_zoom(want).is_ok() {
            p.zooms
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(label.to_owned(), want);
        }
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
        p.modes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(label);
        p.own_ua
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(label);
        p.widths
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(label);
        p.zooms
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
        // Dormant on a desktop page; phone mode's touch (ADR-075, amended).
        .initialization_script(TOUCH_SCRIPT)
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
        .on_page_load(move |w, p| {
            // The drain's own blank page is nobody's news.
            if p.url().scheme() == "about" {
                return;
            }
            let loading = matches!(p.event(), PageLoadEvent::Started);
            // A loaded page in phone mode gets Touch as the user left it
            // (it starts on with a phone's agent: TOUCH_SCRIPT).
            if !loading {
                if let Some(pages) = load.try_state::<Pages>() {
                    let m = pages.mode(w.label());
                    if m.ua.is_some() || m.touch {
                        let _ = w.eval(touch_eval(m.touch));
                    }
                    // A side-by-side page keeps its zoom across a load.
                    let z = pages.zoom(w.label());
                    if (z - 1.0).abs() > 1e-3 {
                        let _ = w.set_zoom(z);
                    }
                }
            }
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
    fn the_key_script_speaks_only_four_words() {
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
    fn phone_mode_has_its_key_from_the_page_on_every_os() {
        assert_eq!(
            key_of(&"caprock-browser:phone".parse().unwrap()),
            Some("phone")
        );
        // ⌥⌘R on macOS (Safari's Responsive Design Mode key), Ctrl+Alt+Shift+D
        // elsewhere (GNOME takes Ctrl+Alt+Shift+R for its screencast) —
        // ui/src/lib/appkeys.ts PHONE_MODE_KEY and keys().
        assert!(KEYS_SCRIPT
            .contains("e.metaKey && e.altKey && !e.ctrlKey && !e.shiftKey && e.code === 'KeyR'"));
        assert!(KEYS_SCRIPT
            .contains("e.ctrlKey && e.altKey && e.shiftKey && !e.metaKey && e.code === 'KeyD'"));
    }

    #[test]
    fn the_touch_script_makes_a_finger_of_the_mouse_and_nothing_else() {
        for needle in [
            "window.top !== window",
            "pointerType: 'touch'",
            "e.pointerType !== 'mouse'",
            "'pointercancel'",
            "touchAction",
            "maxTouchPoints",
            "__caprockTouch",
            "/\\bMobile\\b/.test(navigator.userAgent)",
        ] {
            assert!(TOUCH_SCRIPT.contains(needle), "{needle}");
        }
        // It talks to nobody: no navigation, no network, no storage.
        for never in [
            "location",
            "fetch(",
            "XMLHttpRequest",
            "localStorage",
            "caprock-browser:",
        ] {
            assert!(!TOUCH_SCRIPT.contains(never), "{never}");
        }
        assert_eq!(
            touch_eval(true),
            "window.__caprockTouch && window.__caprockTouch(true)"
        );
    }

    #[test]
    fn a_side_by_side_page_is_zoomed_to_lay_out_at_the_phones_width() {
        // Drawn at 72%: the window is 283 px for a 393 px phone.
        let z = zoom_for(283.0, Some(393.0));
        assert!((283.0 / z - 393.0).abs() < 1e-9);
        // Full size, wider, no width, nonsense: never zoomed.
        assert_eq!(zoom_for(393.0, Some(393.0)), 1.0);
        assert_eq!(zoom_for(500.0, Some(393.0)), 1.0);
        assert_eq!(zoom_for(283.0, None), 1.0);
        assert_eq!(zoom_for(283.0, Some(f64::NAN)), 1.0);
        assert_eq!(zoom_for(1.0, Some(1000.0)), 0.1);
    }

    #[test]
    fn a_measure_is_two_widths_or_nothing() {
        assert_eq!(measured("\"640/375\""), Some((640, 375)));
        assert_eq!(measured("640/375"), Some((640, 375)));
        assert_eq!(measured("\"\""), None);
        assert_eq!(measured("null"), None);
        assert_eq!(measured("\"a/b\""), None);
        assert!(MEASURE_SCRIPT.contains("scrollWidth"));
        let a: Act = serde_json::from_value(serde_json::json!({"do": "measure"})).unwrap();
        assert!(matches!(a, Act::Measure));
        let o: Act = serde_json::from_value(serde_json::json!({"do": "open", "url": "http://localhost:5173/", "rect": {"x": 1, "y": 2, "width": 283, "height": 490}, "phone": {"ua": "UA", "touch": true, "width": 393}})).unwrap();
        assert!(
            matches!(o, Act::Open { phone: Some(Phone { width: Some(w), .. }), .. } if w == 393.0)
        );
    }

    #[test]
    fn a_user_agent_is_one_printable_line() {
        let ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15";
        assert_eq!(user_agent(ua).as_deref(), Some(ua));
        assert_eq!(user_agent(&format!(" {ua} ")).as_deref(), Some(ua));
        for bad in ["", "   ", "a\nb", "a\u{0}b", "caf\u{e9}", &"x".repeat(513)] {
            assert_eq!(user_agent(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn phone_mode_changes_only_what_differs() {
        let phone = |ua: &str, touch| Phone {
            ua: ua.into(),
            touch,
            width: None,
        };
        let desk = Mode::default();
        // On: the device's agent (a reload) and touch.
        let (m, ua, touch) = change(&desk, Some(&phone("UA-A", true)));
        assert_eq!(
            m,
            Mode {
                ua: Some("UA-A".into()),
                touch: true
            }
        );
        assert_eq!(ua, Some(Some("UA-A".into())));
        assert_eq!(touch, Some(true));
        // The same again (a resize, a rotate): nothing.
        assert_eq!(change(&m, Some(&phone("UA-A", true))).1, None);
        assert_eq!(change(&m, Some(&phone("UA-A", true))).2, None);
        // Touch off alone: no reload.
        let (_, ua, touch) = change(&m, Some(&phone("UA-A", false)));
        assert_eq!((ua, touch), (None, Some(false)));
        // Another device: a new agent.
        assert_eq!(
            change(&m, Some(&phone("UA-B", true))).1,
            Some(Some("UA-B".into()))
        );
        // Off: the webview's own agent back, touch off.
        let (m2, ua, touch) = change(&m, None);
        assert_eq!((m2, ua, touch), (Mode::default(), Some(None), Some(false)));
        // A desktop page asked to stay one: nothing.
        assert_eq!(change(&desk, None), (Mode::default(), None, None));
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
        assert!(matches!(
            a,
            Act::Open {
                focus: false,
                phone: None,
                ..
            }
        ));
        let a: Act = serde_json::from_value(serde_json::json!({"do": "open", "url": "https://a.b/", "rect": {"x": 1, "y": 2, "width": 393, "height": 681}, "focus": false, "phone": {"ua": "UA", "touch": true}})).unwrap();
        assert!(
            matches!(a, Act::Open { phone: Some(Phone { ref ua, touch: true, .. }), .. } if ua == "UA")
        );
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
