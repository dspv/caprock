// Caprock desktop shell spike (Tauri v2). Not the product.
//
// Every window loads the daemon's own loopback URL, so the page's origin is the
// daemon's and its Origin / Sec-Fetch-Site checks pass unchanged. The minimal
// terminal window is the xterm.js bundle in ../dist-term injected as an
// initialization script into a same-origin document (manifest.json); a page
// served from the app's own scheme (tauri://localhost on macOS and Linux,
// http://tauri.localhost on Windows) would be refused by the daemon today.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bench;
#[cfg(target_os = "macos")]
mod keys;

use std::sync::{mpsc, Mutex};
use tauri::{AppHandle, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const TERM_JS: &str = include_str!("../../dist-term/term.js");

/// What the page's bench hook sent, stamped when the Rust side received it.
pub struct Report {
    pub recv_epoch_ms: f64,
    pub msg: serde_json::Value,
}

struct ReportTx(Mutex<mpsc::Sender<Report>>);

#[tauri::command]
fn bench_report(msg: String, tx: tauri::State<'_, ReportTx>) {
    let recv_epoch_ms = bench::epoch_ms();
    let msg = serde_json::from_str(&msg).unwrap_or(serde_json::Value::Null);
    let _ = tx.0.lock().map(|t| t.send(Report { recv_epoch_ms, msg }));
}

pub fn arg(name: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1).cloned())
}

fn init_script(mode: &str, sid: &str, bench: bool, first_expect: Option<&str>) -> String {
    let cfg = serde_json::json!({ "mode": mode, "sid": sid, "bench": bench, "firstExpect": first_expect });
    format!("window.__CAPROCK = {cfg};\n{TERM_JS}")
}

/// A window with the minimal xterm.js terminal attached to one session.
pub fn open_term(app: &AppHandle, label: &str, port: u16, sid: &str, bench: bool, first_expect: Option<&str>) -> tauri::Result<WebviewWindow> {
    let url = format!("http://127.0.0.1:{port}/manifest.json").parse().expect("valid URL");
    WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
        .title("Caprock — terminal")
        .inner_size(1400.0, 900.0)
        .initialization_script(init_script("term", sid, bench, first_expect))
        .on_document_title_changed(log_title)
        .focused(!bench)
        .build()
        .inspect(|w| if bench { keep_painting(w) })
}

/// A window with the full existing dashboard, unchanged, from the daemon.
pub fn open_dash(app: &AppHandle, label: &str, port: u16, bench: bool) -> tauri::Result<WebviewWindow> {
    let url = format!("http://127.0.0.1:{port}/").parse().expect("valid URL");
    let mut b = WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
        .title("Caprock")
        .inner_size(1400.0, 900.0)
        .focused(!bench)
        .on_document_title_changed(log_title);
    if bench {
        b = b.initialization_script(init_script("dash", "", true, None));
    }
    b.build().inspect(|w| if bench { keep_painting(w) })
}

fn keep_painting(w: &WebviewWindow) {
    #[cfg(target_os = "macos")]
    let _ = w.with_webview(|wv| keys::keep_painting(wv.inner() as usize));
    #[cfg(not(target_os = "macos"))]
    let _ = w;
}

fn log_title(_: WebviewWindow, title: String) {
    if std::env::var("BENCH_DEBUG").is_ok() {
        eprintln!("title {title}");
    }
}

fn main() {
    let port: u16 = arg("--port").and_then(|p| p.parse().ok()).unwrap_or(4173);
    let sid = arg("--sid");
    let bench_cfg = bench::Cfg::from_args();
    let (tx, rx) = mpsc::channel::<Report>();
    let app = tauri::Builder::default()
        .manage(ReportTx(Mutex::new(tx)))
        .invoke_handler(tauri::generate_handler![bench_report])
        .setup(move |app| {
            let handle = app.handle().clone();
            match bench_cfg {
                Some(cfg) => bench::start(handle, port, sid.unwrap_or_default(), cfg, rx),
                None => {
                    if let Some(sid) = sid.as_deref() {
                        open_term(&handle, "term", port, sid, false, None)?;
                    }
                    open_dash(&handle, "dash", port, false)?;
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("tauri app");
    app.run(|_, ev| {
        // The bench opens and closes windows; it decides when to quit.
        if let tauri::RunEvent::ExitRequested { code: None, api, .. } = ev {
            if bench::ACTIVE.load(std::sync::atomic::Ordering::Relaxed) {
                api.prevent_exit();
            }
        }
    });
}
