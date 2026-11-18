//! Screenshots for a feedback report (ui/src/components/Feedback.tsx): an
//! image onto the system clipboard, the app's own page as a PNG, and an
//! image file the user dropped on the window. .ai/21-app.md § Feedback
//! screenshots.
//!
//! **The clipboard is the shell's.** The page's `navigator.clipboard.write`
//! with an image is at the mercy of each webview — WKWebView wants it inside
//! the click, WebKitGTK may not have it at all — so in the app a screenshot
//! goes through the clipboard manager plugin (arboard underneath). Its
//! JavaScript commands are granted to no page; the page calls
//! `clipboard_image`, which only ever writes an image.
//!
//! **A capture is of the webview, never the screen.** WKWebView's
//! `takeSnapshot` and WebView2's `CapturePreview` draw the app's own page;
//! neither needs the Screen Recording permission that capturing a window
//! through the OS (CGWindowList) asks for. WebKitGTK has
//! `webkit_web_view_get_snapshot`, but it cannot be built and checked on the
//! machines this was written on, so Linux answers "not supported" and the
//! page hides the button there (`captureSupported` in ui/src/lib/shell.ts).
//!
//! **A dropped file is read only if the shell handed it over.** The drop
//! handler (`shell.rs`) records the paths of the last drop; `read_dropped_image`
//! reads one of those and nothing else, an image by its extension, at most
//! 10 MB. Any path at all would turn the command into a file reader for
//! whatever page the window shows. `read_dropped_text` keeps the same rule
//! for the brief of New project from a template: a `.md`, `.markdown` or
//! `.txt` from that drop, at most 1 MiB, UTF-8. `read_dropped_file` keeps it
//! for a file dropped on an open chat, which attaches as the Attach button's
//! pick does: any regular file from that drop, at most 10 MB (the daemon's
//! paste limit), whose bytes the page uploads to the daemon's paste store.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Runtime, Webview};
use tauri_plugin_clipboard_manager::ClipboardExt;

/// GitHub's limit for an image pasted into an issue; the page uses the same.
pub const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;

/// The extensions a dropped file may have to be read as a screenshot.
const IMAGE_EXTENSIONS: [&str; 5] = ["png", "jpg", "jpeg", "gif", "webp"];

/// The paths of the last native drop on the main window.
#[derive(Default)]
pub struct Dropped(Mutex<Vec<PathBuf>>);

impl Dropped {
    pub fn set(&self, paths: &[PathBuf]) {
        if let Ok(mut d) = self.0.lock() {
            *d = paths.to_vec();
        }
    }

    pub(crate) fn contains(&self, p: &Path) -> bool {
        self.0.lock().is_ok_and(|d| d.iter().any(|x| x == p))
    }
}

/// Whether a path names an image the feedback form takes, by its extension.
pub fn is_image_path(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| IMAGE_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

/// Reads a dropped image: one of the last drop's paths, an image by its
/// extension, a file, at most MAX_IMAGE_BYTES.
pub fn read_image(dropped: &Dropped, path: &Path) -> Result<Vec<u8>, String> {
    if !dropped.contains(path) {
        return Err("not a dropped file".into());
    }
    if !is_image_path(path) {
        return Err("not an image".into());
    }
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("not a file".into());
    }
    if meta.len() > MAX_IMAGE_BYTES {
        return Err("over 10 MB".into());
    }
    std::fs::read(path).map_err(|e| e.to_string())
}

/// The bytes of a file dropped on the window, for the feedback form.
#[tauri::command]
pub fn read_dropped_image(
    path: String,
    dropped: tauri::State<'_, Dropped>,
) -> Result<Response, String> {
    read_image(&dropped, Path::new(&path)).map(Response::new)
}

/// A file attached from a drop on a chat: the daemon's paste limit
/// (`pasteLimit` in internal/api/paste.go), the one Attach has.
pub const MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;

/// Reads a file dropped on a chat: one of the last drop's paths, a regular
/// file, at most MAX_FILE_BYTES. Any type: the page keeps to the daemon's
/// allow-list and the daemon decides again on upload; the rule that matters
/// here is that only what the shell just handed over is read.
pub fn read_file(dropped: &Dropped, path: &Path) -> Result<Vec<u8>, String> {
    if !dropped.contains(path) {
        return Err("not a dropped file".into());
    }
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("not a file".into());
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err("over 10 MB".into());
    }
    std::fs::read(path).map_err(|e| e.to_string())
}

/// The bytes of a file dropped on a chat, to attach as Attach would.
#[tauri::command]
pub fn read_dropped_file(
    path: String,
    dropped: tauri::State<'_, Dropped>,
) -> Result<Response, String> {
    read_file(&dropped, Path::new(&path)).map(Response::new)
}

/// The brief New project from a template takes from a file: the daemon's
/// limit for a brief.
pub const MAX_TEXT_BYTES: u64 = 1024 * 1024;

/// The extensions a dropped file may have to be read as a brief.
const TEXT_EXTENSIONS: [&str; 3] = ["md", "markdown", "txt"];

/// Whether a path names a brief by its extension: Markdown or plain text.
pub fn is_text_path(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| TEXT_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

/// Reads a dropped brief: one of the last drop's paths, Markdown or text by
/// its extension, a file, at most MAX_TEXT_BYTES, UTF-8. The same rule as
/// an image: only what the shell just handed over.
pub fn read_text(dropped: &Dropped, path: &Path) -> Result<String, String> {
    if !dropped.contains(path) {
        return Err("not a dropped file".into());
    }
    if !is_text_path(path) {
        return Err("not a .md or .txt file".into());
    }
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("not a file".into());
    }
    if meta.len() > MAX_TEXT_BYTES {
        return Err("over 1 MiB".into());
    }
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    String::from_utf8(bytes).map_err(|_| "not UTF-8 text".into())
}

/// The text of a .md or .txt file dropped on the window, for New project
/// from a template's brief.
#[tauri::command]
pub fn read_dropped_text(
    path: String,
    dropped: tauri::State<'_, Dropped>,
) -> Result<String, String> {
    read_text(&dropped, Path::new(&path))
}

/// Put a PNG, sent as the request's raw body, on the system clipboard.
#[tauri::command]
pub fn clipboard_image<R: Runtime>(request: Request<'_>, app: AppHandle<R>) -> Result<(), String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected the image's bytes".into());
    };
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err("over 10 MB".into());
    }
    let image = tauri::image::Image::from_bytes(bytes).map_err(|e| e.to_string())?;
    app.clipboard()
        .write_image(&image)
        .map_err(|e| e.to_string())
}

/// The calling page as a PNG: the webview's own drawing, never the screen.
#[tauri::command]
pub async fn capture_webview<R: Runtime>(webview: Webview<R>) -> Result<Response, String> {
    let (tx, rx) = std::sync::mpsc::channel::<Result<Vec<u8>, String>>();
    webview
        .with_webview(move |pw| snapshot(pw, tx))
        .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(Duration::from_secs(5))
            .map_err(|_| "the capture did not finish".to_string())?
    })
    .await
    .map_err(|e| e.to_string())?
    .map(Response::new)
}

type Done = std::sync::mpsc::Sender<Result<Vec<u8>, String>>;

#[cfg(target_os = "macos")]
fn snapshot(pw: tauri::webview::PlatformWebview, done: Done) {
    use block2::RcBlock;
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::NSImage;
    use objc2_foundation::NSError;

    let wk = pw.inner() as *mut AnyObject;
    if wk.is_null() {
        let _ = done.send(Err("no webview".into()));
        return;
    }
    // Called once, on the main thread, when WebKit has drawn the page.
    let done = Mutex::new(Some(done));
    let block = RcBlock::new(move |img: *mut NSImage, _err: *mut NSError| {
        // SAFETY: WebKit passes a valid NSImage or nil for the call's duration.
        let out = match unsafe { img.as_ref() } {
            Some(img) => png_of(img),
            None => Err("WebKit returned no image".into()),
        };
        if let Some(tx) = done.lock().ok().and_then(|mut d| d.take()) {
            let _ = tx.send(out);
        }
    });
    // SAFETY: `wk` is the live WKWebView of this window (with_webview runs
    // on the main thread); a nil configuration snapshots the visible page.
    unsafe {
        let _: () = msg_send![
            wk,
            takeSnapshotWithConfiguration: std::ptr::null_mut::<AnyObject>(),
            completionHandler: &*block
        ];
    }
}

#[cfg(target_os = "macos")]
fn png_of(img: &objc2_app_kit::NSImage) -> Result<Vec<u8>, String> {
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep};
    use objc2_foundation::NSDictionary;
    let tiff = img.TIFFRepresentation().ok_or("no TIFF representation")?;
    let rep = NSBitmapImageRep::imageRepWithData(&tiff).ok_or("no bitmap")?;
    // SAFETY: an empty properties dictionary is valid for PNG.
    let png = unsafe {
        rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new())
    }
    .ok_or("could not encode PNG")?;
    Ok(png.to_vec())
}

#[cfg(windows)]
fn snapshot(pw: tauri::webview::PlatformWebview, done: Done) {
    if let Err(e) = capture_preview(pw, done.clone()) {
        let _ = done.send(Err(e.to_string()));
    }
}

#[cfg(windows)]
fn capture_preview(pw: tauri::webview::PlatformWebview, done: Done) -> windows::core::Result<()> {
    use webview2_com::CapturePreviewCompletedHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG;
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::Com::StructuredStorage::CreateStreamOnHGlobal;
    use windows::Win32::System::Com::STREAM_SEEK_SET;

    // SAFETY: COM calls on the webview's own thread (with_webview), on a
    // stream this function owns.
    unsafe {
        let core = pw.controller().CoreWebView2()?;
        let stream = CreateStreamOnHGlobal(HGLOBAL::default(), true)?;
        let read = stream.clone();
        let handler = CapturePreviewCompletedHandler::create(Box::new(move |result| {
            let out = result.map_err(|e| e.to_string()).and_then(|()| {
                let mut bytes = Vec::new();
                read.Seek(0, STREAM_SEEK_SET, None)
                    .map_err(|e| e.to_string())?;
                let mut buf = [0u8; 64 * 1024];
                loop {
                    let mut n = 0u32;
                    read.Read(buf.as_mut_ptr().cast(), buf.len() as u32, Some(&mut n))
                        .ok()
                        .map_err(|e| e.to_string())?;
                    if n == 0 {
                        break;
                    }
                    bytes.extend_from_slice(&buf[..n as usize]);
                }
                Ok(bytes)
            });
            let _ = done.send(out);
            Ok(())
        }));
        core.CapturePreview(
            COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
            &stream,
            &handler,
        )
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
fn snapshot(_pw: tauri::webview::PlatformWebview, done: Done) {
    let _ = done.send(Err("capturing the window is not supported here".into()));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_images_by_extension() {
        for ok in ["a.png", "b.JPG", "c.jpeg", "d.gif", "e.webp"] {
            assert!(is_image_path(Path::new(ok)), "{ok}");
        }
        for no in ["a.txt", "b", "c.png.exe", "d.svg", "e.heic"] {
            assert!(!is_image_path(Path::new(no)), "{no}");
        }
    }

    #[test]
    fn reads_only_what_was_dropped_and_small_enough() {
        let dir = std::env::temp_dir().join(format!("caprock-drop-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let shot = dir.join("shot.png");
        let notes = dir.join("notes.txt");
        let big = dir.join("big.png");
        std::fs::write(&shot, b"png").unwrap();
        std::fs::write(&notes, b"text").unwrap();
        std::fs::File::create(&big)
            .unwrap()
            .set_len(MAX_IMAGE_BYTES + 1)
            .unwrap();
        let dropped = Dropped::default();

        // Not dropped: refused even though it is an image.
        assert!(read_image(&dropped, &shot).is_err());

        dropped.set(&[shot.clone(), notes.clone(), big.clone(), dir.clone()]);
        assert_eq!(read_image(&dropped, &shot).unwrap(), b"png");
        assert_eq!(read_image(&dropped, &notes).unwrap_err(), "not an image");
        assert_eq!(read_image(&dropped, &big).unwrap_err(), "over 10 MB");

        // A later drop replaces the list.
        dropped.set(std::slice::from_ref(&notes));
        assert_eq!(
            read_image(&dropped, &shot).unwrap_err(),
            "not a dropped file"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_chat_reads_any_dropped_file_up_to_10_mb_and_nothing_else() {
        let dir = std::env::temp_dir().join(format!("caprock-dropfile-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let pdf = dir.join("report.pdf");
        let csv = dir.join("data.CSV");
        let shot = dir.join("shot.png");
        let big = dir.join("big.zip");
        let edge = dir.join("edge.txt");
        std::fs::write(&pdf, b"%PDF").unwrap();
        std::fs::write(&csv, b"a,b").unwrap();
        std::fs::write(&shot, b"png").unwrap();
        std::fs::File::create(&big)
            .unwrap()
            .set_len(MAX_FILE_BYTES + 1)
            .unwrap();
        std::fs::File::create(&edge)
            .unwrap()
            .set_len(MAX_FILE_BYTES)
            .unwrap();
        let dropped = Dropped::default();

        // Not dropped: refused, whatever it is.
        assert_eq!(read_file(&dropped, &pdf).unwrap_err(), "not a dropped file");

        dropped.set(&[
            pdf.clone(),
            csv.clone(),
            shot.clone(),
            big.clone(),
            edge.clone(),
            dir.clone(),
        ]);
        assert_eq!(read_file(&dropped, &pdf).unwrap(), b"%PDF");
        assert_eq!(read_file(&dropped, &csv).unwrap(), b"a,b");
        assert_eq!(read_file(&dropped, &shot).unwrap(), b"png");
        assert_eq!(
            read_file(&dropped, &edge).unwrap().len() as u64,
            MAX_FILE_BYTES
        );
        assert_eq!(read_file(&dropped, &big).unwrap_err(), "over 10 MB");
        assert_eq!(read_file(&dropped, &dir).unwrap_err(), "not a file");

        // A later drop replaces the list.
        dropped.set(std::slice::from_ref(&csv));
        assert_eq!(read_file(&dropped, &pdf).unwrap_err(), "not a dropped file");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_brief_is_read_only_from_the_last_drop_as_utf8_text_up_to_1_mib() {
        let dir = std::env::temp_dir().join(format!("caprock-brief-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let md = dir.join("brief.md");
        let upper = dir.join("NOTES.TXT");
        let long = dir.join("long.markdown");
        let shot = dir.join("shot.png");
        let latin1 = dir.join("latin1.txt");
        let big = dir.join("big.md");
        std::fs::write(&md, "# Brief\nA shop for teas. ∂ café\n").unwrap();
        std::fs::write(&upper, b"plain").unwrap();
        std::fs::write(&long, b"x").unwrap();
        std::fs::write(&shot, b"png").unwrap();
        std::fs::write(&latin1, [0x63, 0x61, 0x66, 0xe9]).unwrap();
        std::fs::File::create(&big)
            .unwrap()
            .set_len(MAX_TEXT_BYTES + 1)
            .unwrap();
        let dropped = Dropped::default();

        // Not dropped: refused even though it is a brief.
        assert_eq!(read_text(&dropped, &md).unwrap_err(), "not a dropped file");

        dropped.set(&[
            md.clone(),
            upper.clone(),
            long.clone(),
            shot.clone(),
            latin1.clone(),
            big.clone(),
            dir.clone(),
        ]);
        assert_eq!(
            read_text(&dropped, &md).unwrap(),
            "# Brief\nA shop for teas. ∂ café\n"
        );
        assert_eq!(read_text(&dropped, &upper).unwrap(), "plain");
        assert_eq!(read_text(&dropped, &long).unwrap(), "x");
        assert_eq!(
            read_text(&dropped, &shot).unwrap_err(),
            "not a .md or .txt file"
        );
        assert_eq!(read_text(&dropped, &latin1).unwrap_err(), "not UTF-8 text");
        assert_eq!(read_text(&dropped, &big).unwrap_err(), "over 1 MiB");
        assert!(read_text(&dropped, &dir).is_err());

        // A later drop replaces the list.
        dropped.set(std::slice::from_ref(&shot));
        assert_eq!(read_text(&dropped, &md).unwrap_err(), "not a dropped file");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
