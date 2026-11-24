//! The app's own log: `<data dir>/app.log`, a few lines a day at most, on
//! this machine only (rule 4: nothing is sent anywhere). It records why the
//! window had to recover by itself — the WebView's content process ended, a
//! page that never finished loading, the page's own crash screen — so the
//! next "the window went white" can be answered from the file rather than
//! guessed. `app.log.1` keeps the previous file once it passes `MAX_BYTES`.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

/// The file's name in the data directory.
pub const FILE: &str = "app.log";
/// Past this size the file becomes `app.log.1` and a new one starts.
pub const MAX_BYTES: u64 = 256 * 1024;
/// The longest line kept; a page's message is cut there.
pub const MAX_LINE: usize = 600;
/// Lines a page may write in one run of the app (`page_line`): a page
/// stuck in a loop fills no disk.
pub const PAGE_LINES_PER_RUN: usize = 200;
/// The most indented lines under one `block` (a backtrace, an exception's
/// stack).
pub const MAX_BLOCK_LINES: usize = 100;
/// Objective-C exceptions written in one run (`objc`): one raised on every
/// mouse move fills no disk.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const OBJC_EXCEPTIONS_PER_RUN: usize = 20;
/// The message Rust panics with when an unwind reaches a function that may
/// not unwind: under an `extern "C"` Objective-C method, an Objective-C
/// exception (`core::panicking::panic_cannot_unwind`).
pub const CANNOT_UNWIND: &str = "panic in a function that cannot unwind";

static PAGE_LINES: AtomicUsize = AtomicUsize::new(0);
/// The data directory, once `install_panic_hook` ran: where `guard` and the
/// Objective-C exception log write.
static DIR: OnceLock<PathBuf> = OnceLock::new();

/// One line, with the time in UTC. Never fails: a log that cannot be
/// written is no reason to stop recovering.
pub fn line(data_dir: &Path, msg: &str) {
    let text = format!("{} {}\n", utc(SystemTime::now()), clean(msg));
    let _ = append(data_dir, &text);
}

/// A line, then `body` under it, each body line indented four spaces and
/// cleaned like a line, at most `MAX_BLOCK_LINES` of them: a backtrace or an
/// exception's stack. Written in one append, so a block is never split by
/// another thread's line.
pub fn block<S: AsRef<str>>(data_dir: &Path, head: &str, body: &[S]) {
    let mut text = format!("{} {}\n", utc(SystemTime::now()), clean(head));
    for l in body.iter().take(MAX_BLOCK_LINES) {
        text.push_str("    ");
        text.push_str(&clean(l.as_ref().trim()));
        text.push('\n');
    }
    if body.len() > MAX_BLOCK_LINES {
        text.push_str(&format!(
            "    ({} more lines)\n",
            body.len() - MAX_BLOCK_LINES
        ));
    }
    let _ = append(data_dir, &text);
}

/// Runs `f`, a callback the OS or Tauri calls (a menu item, a window event,
/// a notification's button), and carries on when it panics: the panic
/// hook has written the panic, its place and backtrace; this adds that the
/// app went on, and returns None. A callback inside an Objective-C method
/// must not unwind into it, and a panic in an event handler would end the
/// event loop.
pub fn guard<R>(place: &str, f: impl FnOnce() -> R) -> Option<R> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
        Ok(r) => Some(r),
        Err(_) => {
            if let Some(dir) = DIR.get() {
                line(dir, &format!("{place}: carried on after the panic above"));
            }
            None
        }
    }
}

/// A line the page asked for (the `app_log` command), counted against
/// `PAGE_LINES_PER_RUN`. Returns whether it was written.
pub fn page_line(data_dir: &Path, label: &str, msg: &str) -> bool {
    if PAGE_LINES.fetch_add(1, Ordering::Relaxed) >= PAGE_LINES_PER_RUN {
        return false;
    }
    line(data_dir, &format!("page {label}: {msg}"));
    true
}

fn append(data_dir: &Path, text: &str) -> std::io::Result<()> {
    std::fs::create_dir_all(data_dir)?;
    let path = data_dir.join(FILE);
    if std::fs::metadata(&path).is_ok_and(|m| m.len() >= MAX_BYTES) {
        std::fs::rename(&path, data_dir.join(format!("{FILE}.1")))?;
    }
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    f.write_all(text.as_bytes())
}

/// One line: control characters are spaces, and it is at most `MAX_LINE`
/// characters.
pub fn clean(msg: &str) -> String {
    let s: String = msg
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(MAX_LINE)
        .collect();
    s.trim_end().to_string()
}

/// `2026-10-20T09:41:07Z`.
pub fn utc(t: SystemTime) -> String {
    let secs = t
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (days, rem) = (secs / 86_400, secs % 86_400);
    let (y, m, d) = civil(days as i64);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

/// Writes every panic to the log before the default hook runs: the line
/// `panic at <file>:<line>: <message>`, then the thread and a backtrace.
/// The crash report macOS keeps names only the abort: the drag crash of
/// 0.141.0 and 0.147.0 left nothing that said which unwrap it was.
///
/// A panic that reads `panic in a function that cannot unwind` (0.195.0 and
/// before, about once a week) has no first panic: it is an Objective-C
/// exception unwinding into an `extern "C"` Rust method. On macOS the hook
/// then adds the last Objective-C exception raised in this run — its name,
/// reason and the stack it was raised on — recorded by `objc`.
///
/// Also installs, on macOS, the Objective-C exception log (`objc`).
pub fn install_panic_hook(data_dir: &Path) {
    let _ = DIR.set(data_dir.to_path_buf());
    let dir = data_dir.to_path_buf();
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let msg = panic_message(info);
        let mut body = vec![format!(
            "thread: {}",
            std::thread::current().name().unwrap_or("(unnamed)")
        )];
        if msg == CANNOT_UNWIND {
            body.push(
                "an unwind reached an extern \"C\" function: an Objective-C exception raised under it"
                    .into(),
            );
            #[cfg(target_os = "macos")]
            match objc::last_exception() {
                Some(exc) => {
                    body.push("the last Objective-C exception raised in this run:".into());
                    body.extend(exc);
                }
                None => body.push("no Objective-C exception was raised in this run".into()),
            }
        }
        body.push("backtrace:".into());
        body.extend(backtrace());
        block(&dir, &panic_line(info), &body);
        default(info);
    }));
    #[cfg(target_os = "macos")]
    objc::install();
}

/// The panic's message as it gave it.
fn panic_message<'a>(info: &'a std::panic::PanicHookInfo<'_>) -> &'a str {
    let payload = info.payload();
    payload
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
        .unwrap_or("(no message)")
}

/// `panic at <file>:<line>: <message>`, the message as the panic gave it.
fn panic_line(info: &std::panic::PanicHookInfo<'_>) -> String {
    let at = info
        .location()
        .map(|l| format!("{}:{}", l.file(), l.line()))
        .unwrap_or_else(|| "an unknown place".into());
    format!("panic at {at}: {}", panic_message(info))
}

/// The current thread's stack, a frame a line. A release build is stripped,
/// so on macOS each frame is `<image> +0x<offset>`, the form a crash report
/// uses, which `atos` or a disassembly of the same build resolves; a
/// system library's frame adds its symbol. Elsewhere, Rust's own backtrace.
fn backtrace() -> Vec<String> {
    #[cfg(target_os = "macos")]
    {
        mac_frames()
    }
    #[cfg(not(target_os = "macos"))]
    {
        std::backtrace::Backtrace::force_capture()
            .to_string()
            .lines()
            .map(str::to_string)
            .collect()
    }
}

#[cfg(target_os = "macos")]
fn mac_frames() -> Vec<String> {
    use std::ffi::CStr;
    let mut ips = [std::ptr::null_mut::<libc::c_void>(); 64];
    // SAFETY: the buffer holds `len` pointers.
    let n = unsafe { libc::backtrace(ips.as_mut_ptr(), ips.len() as libc::c_int) };
    let n = usize::try_from(n).unwrap_or(0).min(ips.len());
    ips[..n]
        .iter()
        .map(|&ip| {
            // SAFETY: a zeroed Dl_info is valid; dladdr only fills it.
            let mut info: libc::Dl_info = unsafe { std::mem::zeroed() };
            // SAFETY: `ip` is a return address of this stack.
            if unsafe { libc::dladdr(ip, &mut info) } == 0 || info.dli_fbase.is_null() {
                return format!("{ip:p}");
            }
            let cstr = |p: *const libc::c_char| {
                // SAFETY: dladdr's strings are NUL-terminated and live as
                // long as the image.
                (!p.is_null()).then(|| unsafe { CStr::from_ptr(p) }.to_string_lossy())
            };
            let path = cstr(info.dli_fname).unwrap_or_default();
            let image = path.rsplit('/').next().unwrap_or_default().to_string();
            let off = (ip as usize).wrapping_sub(info.dli_fbase as usize);
            // A stripped executable's nearest symbol is its Mach-O header:
            // no name rather than a wrong one.
            let sym = cstr(info.dli_sname)
                .filter(|s| !s.starts_with("__mh_"))
                .map(|s| format!(" {s}"))
                .unwrap_or_default();
            format!("{image} +{off:#x}{sym}")
        })
        .collect()
}

/// Objective-C exceptions in the app log (macOS).
///
/// - **Caught.** Tao's `sendEvent:` overrides catch an exception AppKit
///   raises while handling an event (`patched/tao`, `CAPROCK PATCH`) and log
///   it under `TARGET` through the `log` crate; the logger here writes it
///   with its stack, at most `OBJC_EXCEPTIONS_PER_RUN` a run. The app
///   carries on, as AppKit's own run loop would.
/// - **Not caught.** Every exception raised passes the runtime's exception
///   preprocessor; the last one is kept (retained, not formatted: cheap),
///   and the panic hook describes it when an unwind aborted the app.
#[cfg(target_os = "macos")]
pub mod objc {
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::{msg_send, sel};
    use objc2_foundation::NSString;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Mutex, OnceLock};

    /// The log target tao's patch writes caught exceptions under; it must
    /// equal `OBJC_EXCEPTION_TARGET` in `patched/tao` (a test checks).
    pub const TARGET: &str = "caprock::objc_exception";

    type Preprocessor = unsafe extern "C" fn(*mut AnyObject) -> *mut AnyObject;

    extern "C" {
        // libobjc, <objc/objc-exception.h>: called with every exception
        // raised, before the unwind; returns the exception to raise.
        fn objc_setExceptionPreprocessor(f: Option<Preprocessor>) -> Option<Preprocessor>;
    }

    struct Held(Retained<AnyObject>);
    // SAFETY: an NSException is immutable; the slot only retains, releases
    // and reads it.
    unsafe impl Send for Held {}

    static LAST: Mutex<Option<Held>> = Mutex::new(None);
    static PREVIOUS: OnceLock<Option<Preprocessor>> = OnceLock::new();
    static WRITTEN: AtomicUsize = AtomicUsize::new(0);

    struct Logger;

    impl log::Log for Logger {
        fn enabled(&self, m: &log::Metadata<'_>) -> bool {
            m.target() == TARGET && m.level() <= log::Level::Error
        }

        fn log(&self, r: &log::Record<'_>) {
            if !self.enabled(r.metadata())
                || WRITTEN.fetch_add(1, Ordering::Relaxed) >= super::OBJC_EXCEPTIONS_PER_RUN
            {
                return;
            }
            let Some(dir) = super::DIR.get() else { return };
            let text = r.args().to_string();
            let mut lines = text.lines();
            let head = lines.next().unwrap_or_default();
            let body: Vec<&str> = lines.collect();
            super::block(
                dir,
                &format!("objc exception, caught; the app carries on: {head}"),
                &body,
            );
        }

        fn flush(&self) {}
    }

    /// The preprocessor and the logger, once. Another logger already set
    /// (none is today) keeps its place.
    pub fn install() {
        PREVIOUS.get_or_init(|| {
            // SAFETY: `record` matches the preprocessor's signature and
            // hands the exception on unchanged.
            unsafe { objc_setExceptionPreprocessor(Some(record)) }
        });
        static LOGGER: Logger = Logger;
        if log::set_logger(&LOGGER).is_ok() {
            log::set_max_level(log::LevelFilter::Error);
        }
    }

    /// Keeps the exception being raised, then hands it to the preprocessor
    /// that was there before. Never panics, never blocks: a held lock
    /// skips the keeping.
    unsafe extern "C" fn record(exc: *mut AnyObject) -> *mut AnyObject {
        // SAFETY: the runtime passes the exception object, or nil.
        if let Some(held) = unsafe { Retained::retain(exc) } {
            if let Ok(mut slot) = LAST.try_lock() {
                let old = slot.replace(Held(held));
                drop(slot);
                drop(old);
            }
        }
        match PREVIOUS.get().copied().flatten() {
            // SAFETY: the runtime's own previous preprocessor.
            Some(prev) => unsafe { prev(exc) },
            None => exc,
        }
    }

    /// The last exception raised in this run: name and reason, then the
    /// stack it was raised on.
    pub fn last_exception() -> Option<Vec<String>> {
        let slot = LAST.try_lock().ok()?;
        slot.as_ref().map(|h| describe(&h.0))
    }

    /// `<name>: <reason>`, then `callStackSymbols`, a frame a line. Every
    /// message is asked whether it is answered first: the object raised
    /// need not be an NSException.
    pub fn describe(obj: &AnyObject) -> Vec<String> {
        let text = |sel_name, s: Option<Retained<NSString>>| -> String {
            s.map(|s| s.to_string())
                .unwrap_or_else(|| format!("(no {sel_name})"))
        };
        // SAFETY: each message is sent only to an object that answers it;
        // NSException's name and reason are NSStrings, callStackSymbols an
        // NSArray of NSString.
        unsafe {
            let answers = |s| -> bool { msg_send![obj, respondsToSelector: s] };
            if !answers(sel!(name)) || !answers(sel!(reason)) {
                let d: Option<Retained<NSString>> = msg_send![obj, description];
                return vec![text("description", d)];
            }
            let name: Option<Retained<NSString>> = msg_send![obj, name];
            let reason: Option<Retained<NSString>> = msg_send![obj, reason];
            let mut out = vec![format!(
                "{}: {}",
                text("name", name),
                text("reason", reason)
            )];
            if answers(sel!(callStackSymbols)) {
                let arr: Option<Retained<AnyObject>> = msg_send![obj, callStackSymbols];
                if let Some(arr) = arr {
                    let count: usize = msg_send![&*arr, count];
                    for i in 0..count {
                        let s: Option<Retained<NSString>> = msg_send![&*arr, objectAtIndex: i];
                        out.push(text("frame", s));
                    }
                }
            }
            out
        }
    }
}

/// Days since 1970-01-01 to (year, month, day) in the proleptic Gregorian
/// calendar (Howard Hinnant's `civil_from_days`).
fn civil(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn scratch(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!(
            "caprock-applog-{tag}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn the_time_is_utc_to_the_second() {
        assert_eq!(utc(UNIX_EPOCH), "1970-01-01T00:00:00Z");
        let t = UNIX_EPOCH + Duration::from_secs(1_792_489_267);
        assert_eq!(utc(t), "2026-10-20T09:41:07Z");
        // A leap day.
        let t = UNIX_EPOCH + Duration::from_secs(1_709_164_800);
        assert_eq!(utc(t), "2024-02-29T00:00:00Z");
    }

    #[test]
    fn a_line_is_one_line_and_short() {
        assert_eq!(clean("a\nb\tc\r"), "a b c");
        assert_eq!(clean(&"x".repeat(5000)).chars().count(), MAX_LINE);
    }

    #[test]
    fn lines_append_and_the_file_rolls_over() {
        let dir = scratch("roll");
        line(&dir, "first");
        line(&dir, "second");
        let text = std::fs::read_to_string(dir.join(FILE)).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].ends_with("Z first"), "{}", lines[0]);
        std::fs::write(dir.join(FILE), vec![b'.'; MAX_BYTES as usize]).unwrap();
        line(&dir, "after");
        assert_eq!(
            std::fs::metadata(dir.join(format!("{FILE}.1")))
                .unwrap()
                .len(),
            MAX_BYTES
        );
        let fresh = std::fs::read_to_string(dir.join(FILE)).unwrap();
        assert!(fresh.ends_with(" after\n") && fresh.lines().count() == 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_panic_is_written_with_its_place_message_thread_and_backtrace() {
        // The hook is process-wide: install it, panic on a thread, put the
        // default back. One test only installs it, or one test's put-back
        // could drop the other's hook mid-run. Other tests that panic on
        // purpose may add lines to this scratch file meanwhile; only ours
        // is looked for.
        let dir = scratch("panic");
        install_panic_hook(&dir);
        let r = std::thread::Builder::new()
            .name("caprock-test-trace".into())
            .spawn(|| -> u8 { panic!("dropped file names") })
            .unwrap()
            .join();
        let _ = std::panic::take_hook();
        assert!(r.is_err());
        let text = std::fs::read_to_string(dir.join(FILE)).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        let at = lines
            .iter()
            .position(|l| {
                (l.contains("panic at src/applog.rs:") || l.contains("panic at src\\applog.rs:"))
                    && l.ends_with(": dropped file names")
            })
            .unwrap_or_else(|| panic!("{text}"));
        assert_eq!(lines[at + 1], "    thread: caprock-test-trace", "{text}");
        assert_eq!(lines[at + 2], "    backtrace:", "{text}");
        let frames = lines[at + 3..]
            .iter()
            .take_while(|l| l.starts_with("    "))
            .count();
        assert!(frames >= 3, "{text}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_block_is_indented_one_line_each_and_capped() {
        let dir = scratch("block");
        let body: Vec<String> = (0..MAX_BLOCK_LINES + 5)
            .map(|i| format!("frame {i}\tx"))
            .collect();
        block(&dir, "head\nline", &body);
        let text = std::fs::read_to_string(dir.join(FILE)).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert!(lines[0].ends_with("Z head line"), "{}", lines[0]);
        assert_eq!(lines[1], "    frame 0 x");
        assert_eq!(lines.len(), 1 + MAX_BLOCK_LINES + 1);
        assert_eq!(lines[lines.len() - 1], "    (5 more lines)");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_guarded_callback_that_panics_returns_none_and_the_app_goes_on() {
        // The hook is left alone (see the panic test): the panic prints to
        // the test's captured output.
        assert_eq!(guard("ok", || 7), Some(7));
        let r: Option<u8> = guard("test callback", || panic!("in a callback"));
        assert_eq!(r, None);
    }

    /// Tao's patch logs under the target the app's logger listens to, and
    /// both sendEvent: overrides go through the catch: a tao bump that
    /// loses either brings back the abort of 0.195.0.
    #[test]
    fn the_patched_send_event_overrides_catch_objc_exceptions() {
        let util = include_str!("../patched/tao/src/platform_impl/macos/util/mod.rs");
        let app = include_str!("../patched/tao/src/platform_impl/macos/app.rs");
        let window = include_str!("../patched/tao/src/platform_impl/macos/window.rs");
        let toml = include_str!("../patched/tao/Cargo.toml");
        assert!(util.contains("OBJC_EXCEPTION_TARGET: &str = \"caprock::objc_exception\""));
        #[cfg(target_os = "macos")]
        assert_eq!(objc::TARGET, "caprock::objc_exception");
        for (name, src) in [("app.rs", app), ("window.rs", window)] {
            let src = src.replace("\r\n", "\n");
            let body = src
                .split("extern \"C\" fn send_event(")
                .nth(1)
                .and_then(|r| r.split("\n}\n").next())
                .unwrap_or_else(|| panic!("{name}: no send_event"));
            assert!(
                body.contains("util::catch_objc_exception("),
                "{name}: {body}"
            );
            let catch_at = body.find("catch_objc_exception").unwrap();
            let super_at = body.find("sendEvent: event").unwrap();
            assert!(catch_at < super_at, "{name}: {body}");
        }
        assert!(toml.contains("features = [\"exception\"]"));
        let profile = include_str!("../Cargo.toml")
            .split("[profile.release]")
            .nth(1)
            .unwrap()
            .to_string();
        assert!(profile.contains("panic = \"unwind\""), "{profile}");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn an_objc_exception_is_kept_and_described_with_its_stack() {
        use objc2::{class, msg_send};
        use objc2_foundation::NSString;
        objc::install();
        let r = objc2::exception::catch(|| unsafe {
            let name = NSString::from_str("CaprockTestException");
            let reason = NSString::from_str("raised by a test");
            let _: () = msg_send![class!(NSException), raise: &*name, format: &*reason];
        });
        let exc = r.expect_err("raised").expect("an exception object");
        let caught = objc::describe(exc.as_ref());
        assert_eq!(caught[0], "CaprockTestException: raised by a test");
        assert!(caught.len() > 2, "{caught:?}");
        // Another test's exception may land in the slot meanwhile; ours was
        // kept unless that happened.
        let last = objc::last_exception().expect("kept");
        assert!(last[0].contains(": "), "{last:?}");
    }

    #[test]
    fn a_missing_data_dir_is_made_and_an_unwritable_one_is_no_error() {
        let dir = scratch("made").join("deeper");
        line(&dir, "x");
        assert!(dir.join(FILE).exists());
        // A file where the directory should be: nothing written, no panic.
        let file = scratch("file").join("plain");
        std::fs::write(&file, b"").unwrap();
        line(&file, "x");
    }
}
