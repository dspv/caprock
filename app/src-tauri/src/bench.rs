// The spike's typing benchmark, symmetric with macos/bench (SwiftTerm) and
// web.mjs (Chrome). On only when --bench-out <file> is passed.
//
// Per key: the Rust side records the wall clock just before posting the
// NSEvent; the page's hook (term/main.ts) waits for the fake claude's echo
// "> <typed>\x1b" on the /term socket, lets xterm.js parse everything queued
// (term.write('', cb)), waits for the next animation frame and a task after it,
// and reports performance.timeOrigin + performance.now(). paint - post is the
// headline; socket and IPC arrival are kept for the split.
use crate::{arg, open_dash, open_term, Report};
use rand::Rng;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, WebviewWindow};

pub static ACTIVE: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Copy, PartialEq)]
pub enum Mode {
    Term,
    Dash,
    Idle,
}

pub struct Cfg {
    mode: Mode,
    keys: usize,
    watch: f64,
    warm_opens: usize,
    out: String,
}

impl Cfg {
    pub fn from_args() -> Option<Cfg> {
        let out = arg("--bench-out")?;
        let mode = match arg("--bench-mode").as_deref() {
            Some("dash") => Mode::Dash,
            Some("idle") => Mode::Idle,
            _ => Mode::Term,
        };
        Some(Cfg {
            mode,
            keys: arg("--bench-keys").and_then(|v| v.parse().ok()).unwrap_or(100),
            watch: arg("--bench-watch").and_then(|v| v.parse().ok()).unwrap_or(20.0),
            warm_opens: arg("--bench-warm-opens").and_then(|v| v.parse().ok()).unwrap_or(3),
            out,
        })
    }
}

pub fn epoch_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0)
}

fn nonce() -> String {
    let abc: Vec<char> = "abcdefghijklmnopqrstuvwyz".chars().collect();
    let mut r = rand::thread_rng();
    (0..4).map(|_| abc[r.gen_range(0..abc.len())]).collect()
}

fn pct(v: &[f64], p: f64) -> Option<f64> {
    if v.is_empty() {
        return None;
    }
    let mut s = v.to_vec();
    s.sort_by(|a, b| a.partial_cmp(b).unwrap());
    Some(s[((s.len() - 1) as f64 * p).round() as usize])
}

pub fn start(app: AppHandle, port: u16, sid: String, cfg: Cfg, rx: Receiver<Report>) {
    ACTIVE.store(true, Ordering::Relaxed);
    std::thread::spawn(move || {
        let mut b = Bench { app: app.clone(), port, sid, rx, log: vec![] };
        let result = b.run(&cfg);
        let _ = std::fs::write(&cfg.out, serde_json::to_string_pretty(&result).unwrap_or_default());
        ACTIVE.store(false, Ordering::Relaxed);
        app.exit(0);
    });
}

struct Bench {
    app: AppHandle,
    port: u16,
    sid: String,
    rx: Receiver<Report>,
    log: Vec<Value>,
}

impl Bench {
    fn run(&mut self, cfg: &Cfg) -> Value {
        let launch = std::env::var("BENCH_T0").ok().and_then(|v| v.parse::<f64>().ok());
        let mut r = json!({ "lps": std::env::var("BENCH_LPS").ok(), "keys": cfg.keys });
        let win = match cfg.mode {
            Mode::Idle => return self.idle(cfg, r),
            Mode::Term => {
                r["client"] = json!("tauri-term");
                let n = nonce();
                let t_pane = epoch_ms();
                let w = open_term(&self.app, "term", self.port, &self.sid, true, Some(&n)).expect("term window");
                let first = self.first_echo(&w, &n, None);
                if let Some(f) = &first {
                    r["pane_to_first_echo_paint_ms"] = json!(f["paint"].as_f64().unwrap_or(0.0) - t_pane);
                    if let Some(t0) = launch {
                        r["launch_to_first_echo_paint_ms"] = json!(f["paint"].as_f64().unwrap_or(0.0) - t0);
                    }
                }
                w
            }
            Mode::Dash => {
                r["client"] = json!("tauri-dash");
                let w = open_dash(&self.app, "dash", self.port, true).expect("dash window");
                self.wait_kind("ready", Duration::from_secs(30));
                std::thread::sleep(Duration::from_secs(4));
                let n = nonce();
                self.arm(&w, Some(&n), true);
                let t0 = epoch_ms();
                let _ = w.eval(&format!("location.hash = {}", json!(format!("#/session/{}?tab=terminal", self.sid))));
                let focus = "(() => { const a = document.activeElement; if (!a || !a.classList.contains('xterm-helper-textarea')) document.querySelector('.xterm-helper-textarea')?.focus() })()";
                if let Some(f) = self.first_echo(&w, &n, Some(focus)) {
                    r["nav_to_first_echo_paint_ms"] = json!(f["paint"].as_f64().unwrap_or(0.0) - t0);
                    if let Some(l) = launch {
                        r["launch_to_first_echo_paint_ms"] = json!(f["paint"].as_f64().unwrap_or(0.0) - l);
                    }
                }
                w
            }
        };
        std::thread::sleep(Duration::from_secs(2));
        self.steady(&win, cfg.keys, &mut r);
        let _ = win.eval("window.__bench.grid()");
        if let Some(g) = self.wait_kind("grid", Duration::from_secs(2)) {
            for k in ["cols", "rows", "dpr", "inner", "clock_skew_ms"] {
                r[k] = g.msg[k].clone();
            }
        }
        r["watch"] = self.watch(cfg.watch);
        let w = r["watch"].clone();
        r["watch_cpu_pct"] = w["cpu_pct"].clone();
        r["rss_mb_end"] = w["rss_mb_end"].clone();
        r["rss_mb_peak"] = w["rss_mb_peak"].clone();
        if cfg.mode == Mode::Term {
            r["warm_open_to_first_echo_paint_ms"] = json!(self.warm_opens(win, cfg.warm_opens));
        }
        r["page_events"] = json!(self.log);
        if let Some(ready) = self.log.iter().find(|m| m["kind"] == "ready") {
            for k in ["renderer", "webgl_ms", "timer_res_ms", "ua"] {
                r[k] = ready[k].clone();
            }
        }
        r["visible"] = json!(true);
        r
    }

    fn idle(&mut self, cfg: &Cfg, mut r: Value) -> Value {
        r["client"] = json!("tauri-idle-dashboard");
        let _w = open_dash(&self.app, "dash", self.port, false).expect("dash window");
        std::thread::sleep(Duration::from_secs(10));
        r["watch"] = self.watch(cfg.watch);
        r
    }

    /// Next report, keeping every non-timing message in the log.
    fn next(&mut self, until: Instant) -> Option<Report> {
        let left = until.checked_duration_since(Instant::now())?;
        match self.rx.recv_timeout(left) {
            Ok(rep) => {
                if std::env::var("BENCH_DEBUG").is_ok() {
                    eprintln!("report {}", rep.msg);
                }
                let k = rep.msg["kind"].as_str().unwrap_or("");
                if k != "key" && k != "armed" {
                    self.log.push(rep.msg.clone());
                }
                Some(rep)
            }
            Err(_) => None,
        }
    }

    fn wait_kind(&mut self, kind: &str, timeout: Duration) -> Option<Report> {
        let until = Instant::now() + timeout;
        while let Some(rep) = self.next(until) {
            if rep.msg["kind"] == kind {
                return Some(rep);
            }
        }
        None
    }

    fn arm(&mut self, w: &WebviewWindow, expect: Option<&str>, first: bool) {
        while self.rx.try_recv().is_ok() {}
        let _ = w.eval(&format!("window.__bench && window.__bench.arm({}, {first})", json!(expect)));
        self.wait_kind("armed", Duration::from_secs(2));
    }

    /// Posts `c` on the main thread; returns the wall clock just before posting.
    fn key(&self, w: &WebviewWindow, c: char) -> f64 {
        let (tx, rx) = mpsc::channel();
        #[cfg(target_os = "macos")]
        {
            let ns = w.ns_window().map(|p| p as usize).unwrap_or(0);
            let _ = self.app.run_on_main_thread(move || {
                let t = epoch_ms();
                crate::keys::post(ns, c);
                let _ = tx.send(t);
            });
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (w, c);
            let _ = tx.send(epoch_ms());
        }
        rx.recv().unwrap_or(0.0)
    }

    /// A user who starts typing at once: the nonce every 100 ms until it shows.
    fn first_echo(&mut self, w: &WebviewWindow, n: &str, focus_js: Option<&str>) -> Option<Value> {
        let until = Instant::now() + Duration::from_secs(30);
        while Instant::now() < until {
            if let Some(js) = focus_js {
                let _ = w.eval(js);
            }
            for c in n.chars() {
                self.key(w, c);
            }
            if let Some(rep) = self.wait_kind("first", Duration::from_millis(100)) {
                return Some(rep.msg);
            }
        }
        None
    }

    fn steady(&mut self, w: &WebviewWindow, keys: usize, r: &mut Value) {
        let (mut paint, mut sock, mut kd, mut ipc) = (vec![], vec![], vec![], vec![]);
        let mut timeouts = 0;
        let mut typed = String::new();
        let mut rng = rand::thread_rng();
        let abc: Vec<char> = "abcdefghijklmnopqrstuvwxyz".chars().collect();
        for i in 0..keys {
            if i % 20 == 0 {
                self.arm(w, None, false);
                self.key(w, '\r');
                typed.clear();
                std::thread::sleep(Duration::from_millis(300));
            }
            let c = abc[rng.gen_range(0..abc.len())];
            typed.push(c);
            self.arm(w, Some(&format!("> {typed}\u{1b}")), false);
            let t = self.key(w, c);
            match self.wait_kind("key", Duration::from_secs(3)) {
                Some(rep) => {
                    let m = &rep.msg;
                    paint.push(m["paint"].as_f64().unwrap_or(0.0) - t);
                    sock.push(m["sock"].as_f64().unwrap_or(0.0) - t);
                    if let Some(k) = m["keydown"].as_f64() {
                        kd.push(k - t);
                    }
                    ipc.push(rep.recv_epoch_ms - t);
                }
                None => timeouts += 1,
            }
            std::thread::sleep(Duration::from_millis(rng.gen_range(120..200)));
        }
        let round = |v: &Vec<f64>| v.iter().map(|x| (x * 10.0).round() / 10.0).collect::<Vec<_>>();
        r["n"] = json!(paint.len());
        r["timeouts"] = json!(timeouts);
        r["paint_p50_ms"] = json!(pct(&paint, 0.5));
        r["paint_p95_ms"] = json!(pct(&paint, 0.95));
        r["paint_max_ms"] = json!(paint.iter().cloned().fold(0.0, f64::max));
        r["socket_p50_ms"] = json!(pct(&sock, 0.5));
        r["socket_p95_ms"] = json!(pct(&sock, 0.95));
        r["keydown_p50_ms"] = json!(pct(&kd, 0.5));
        r["ipc_report_p50_ms"] = json!(pct(&ipc, 0.5));
        r["paint_ms"] = json!(round(&paint));
        r["socket_ms"] = json!(round(&sock));
    }

    /// CPU and RSS of this app's processes (incl. WebKit helpers) via procs.py.
    fn watch(&self, secs: f64) -> Value {
        let script = std::env::var("BENCH_PROCS").unwrap_or_else(|_| "procs.py".into());
        let exe = std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
        let out = std::process::Command::new("python3")
            .args([script, std::process::id().to_string(), secs.to_string(), exe])
            .output();
        out.ok().and_then(|o| serde_json::from_slice(&o.stdout).ok()).unwrap_or(Value::Null)
    }

    /// Opening another terminal window in the warm app, to the first echo.
    fn warm_opens(&mut self, mut prev: WebviewWindow, count: usize) -> Vec<f64> {
        let mut v = vec![];
        for k in 0..count {
            std::thread::sleep(Duration::from_secs(1));
            let n = nonce();
            let t = epoch_ms();
            let w = match open_term(&self.app, &format!("term-{k}"), self.port, &self.sid, true, Some(&n)) {
                Ok(w) => w,
                Err(_) => break,
            };
            if let Some(f) = self.first_echo(&w, &n, None) {
                v.push(f["paint"].as_f64().unwrap_or(0.0) - t);
            }
            let _ = prev.close();
            prev = w;
        }
        v
    }
}
