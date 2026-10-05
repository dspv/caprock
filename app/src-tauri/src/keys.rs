// macOS key injection for the bench, in-process only: an NSEvent handed to our
// own NSWindow.sendEvent → first responder (WKWebView) keyDown, the path a
// typed key takes once AppKit has picked the key window. Nothing system-wide
// (no CGEvent, no activation): the app stays in the background, so the owner's
// focused window never receives anything.
use objc2::runtime::AnyObject;
use objc2::{class, msg_send};
use objc2_foundation::{NSPoint, NSString};

const NS_KEY_DOWN: usize = 10;
const NS_KEY_UP: usize = 11;

fn key_code(c: char) -> u16 {
    // kVK_ANSI_* from Carbon's Events.h
    match c {
        'a' => 0, 's' => 1, 'd' => 2, 'f' => 3, 'h' => 4, 'g' => 5, 'z' => 6, 'x' => 7, 'c' => 8, 'v' => 9,
        'b' => 11, 'q' => 12, 'w' => 13, 'e' => 14, 'r' => 15, 'y' => 16, 't' => 17, 'o' => 31, 'u' => 32,
        'i' => 34, 'p' => 35, 'l' => 37, 'j' => 38, 'k' => 40, 'n' => 45, 'm' => 46, '\r' => 36,
        _ => 0,
    }
}

/// Keeps a background (occluded) WKWebView painting, like Chrome's
/// --disable-backgrounding-occluded-windows in web.mjs. WebKit SPI.
pub fn keep_painting(wk_webview: usize) {
    unsafe {
        let v = wk_webview as *mut AnyObject;
        let sel = objc2::sel!(_setWindowOcclusionDetectionEnabled:);
        let ok: bool = msg_send![v, respondsToSelector: sel];
        if ok {
            let _: () = msg_send![v, _setWindowOcclusionDetectionEnabled: false];
        }
    }
}

/// Sends keyDown + keyUp for `c` to our window. Must run on the main thread.
pub fn post(ns_window: usize, c: char) {
    unsafe {
        let win = ns_window as *mut AnyObject;
        let num: isize = msg_send![win, windowNumber];
        let info: *mut AnyObject = msg_send![class!(NSProcessInfo), processInfo];
        let ts: f64 = msg_send![info, systemUptime];
        let chars = NSString::from_str(&c.to_string());
        for ty in [NS_KEY_DOWN, NS_KEY_UP] {
            let ev: *mut AnyObject = msg_send![class!(NSEvent),
                keyEventWithType: ty,
                location: NSPoint::new(0.0, 0.0),
                modifierFlags: 0usize,
                timestamp: ts,
                windowNumber: num,
                context: std::ptr::null_mut::<AnyObject>(),
                characters: &*chars,
                charactersIgnoringModifiers: &*chars,
                isARepeat: false,
                keyCode: key_code(c)];
            let _: () = msg_send![win, sendEvent: ev];
        }
    }
}

/// Opts the bench out of App Nap: it runs in the background on purpose, and
/// a napping app's timers are coalesced, which would bias every latency.
pub fn no_app_nap() {
    // NSActivityUserInitiatedAllowingIdleSystemSleep | NSActivityLatencyCritical
    const OPTIONS: u64 = 0x00EF_FFFF | 0xFF_0000_0000;
    unsafe {
        let info: *mut AnyObject = msg_send![class!(NSProcessInfo), processInfo];
        let reason = NSString::from_str("Caprock spike typing benchmark");
        let token: *mut AnyObject = msg_send![info, beginActivityWithOptions: OPTIONS, reason: &*reason];
        // Held for the life of the process.
        let _: *mut AnyObject = msg_send![token, retain];
    }
}
