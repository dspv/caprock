//! The Dock icon after an in-app update (macOS). The updater swaps
//! `/Applications/Caprock.app` in place, and the Dock and LaunchServices keep
//! drawing the icon they cached for the old bundle: 0.109.1 changed the icon
//! and updated installs went on showing the old one. Two things, neither
//! intrusive (no Dock or Finder restart, no prompt, no privilege):
//!
//! - every launch, the running app's Dock tile is set from the bundle's own
//!   `icon.icns`, so it is right at once whatever the cache holds;
//! - once per version, the bundle's mtime is touched and the bundle is
//!   re-registered with LaunchServices (`lsregister -f`), so the cache itself
//!   catches up for the Dock when the app is not running, Finder and Launchpad.
//!
//! Only from a real `.app` bundle; `cargo run` changes nothing.

use std::path::{Path, PathBuf};

/// `<data_dir>/app-last-run-version`: the app version that last started.
const LAST_RUN: &str = "app-last-run-version";

/// The `.app` bundle an executable runs from (`<X>.app/Contents/MacOS/<exe>`
/// with an `Info.plist`), or `None` for a loose binary such as `cargo run`'s.
pub fn bundle_of(exe: &Path) -> Option<PathBuf> {
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    let shaped = macos.file_name()? == "MacOS"
        && contents.file_name()? == "Contents"
        && bundle.extension()? == "app"
        && contents.join("Info.plist").is_file();
    shaped.then(|| bundle.to_path_buf())
}

/// The bundle's icon. Tauri names it `icon.icns` (`CFBundleIconFile`).
pub fn icon_of(bundle: &Path) -> PathBuf {
    bundle.join("Contents").join("Resources").join("icon.icns")
}

/// Records `version` as the last one run and says whether it is new: no
/// record (a fresh install, or an update from before this existed) or a
/// different one. A record that cannot be written answers false, so a
/// read-only data directory never refreshes on every launch.
pub fn first_run_of(data_dir: &Path, version: &str) -> bool {
    let file = data_dir.join(LAST_RUN);
    let last = std::fs::read_to_string(&file).ok();
    if last.as_deref().map(str::trim) == Some(version) {
        return false;
    }
    let tmp = data_dir.join(format!("{LAST_RUN}.tmp"));
    std::fs::create_dir_all(data_dir)
        .and_then(|()| std::fs::write(&tmp, version))
        .and_then(|()| std::fs::rename(&tmp, &file))
        .is_ok()
}

/// Called from setup, on the main thread.
#[cfg(target_os = "macos")]
pub fn install(data_dir: &Path, version: &str) {
    let Some(bundle) = std::env::current_exe().ok().and_then(|e| bundle_of(&e)) else {
        return;
    };
    show(&icon_of(&bundle));
    if first_run_of(data_dir, version) {
        std::thread::spawn(move || refresh(&bundle));
    }
}

/// The running app's Dock tile from the bundle's icon. The badge is the
/// Dock tile's label, drawn over whatever image this sets.
#[cfg(target_os = "macos")]
fn show(icon: &Path) {
    use objc2::{AnyThread, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::NSString;

    let (Some(mtm), Some(path)) = (MainThreadMarker::new(), icon.to_str()) else {
        return;
    };
    let Some(image) = NSImage::initWithContentsOfFile(NSImage::alloc(), &NSString::from_str(path))
    else {
        return;
    };
    // SAFETY: on the main thread (the marker), with a non-nil image.
    unsafe { NSApplication::sharedApplication(mtm).setApplicationIconImage(Some(&image)) };
}

#[cfg(target_os = "macos")]
const LSREGISTER: &str = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

/// Touches the bundle and re-registers it with LaunchServices. Every error
/// is ignored; lsregister is given ten seconds.
#[cfg(target_os = "macos")]
fn refresh(bundle: &Path) {
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    let _ = touch(bundle);
    let Ok(mut child) = Command::new(LSREGISTER)
        .arg("-f")
        .arg(bundle)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    else {
        return;
    };
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if !matches!(child.try_wait(), Ok(None)) {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Sets a directory's mtime to now.
#[cfg(target_os = "macos")]
fn touch(dir: &Path) -> std::io::Result<()> {
    std::fs::File::open(dir)?.set_modified(std::time::SystemTime::now())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("caprock-dock-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn fake_bundle(root: &Path) -> PathBuf {
        let bundle = root.join("Caprock.app");
        std::fs::create_dir_all(bundle.join("Contents").join("MacOS")).unwrap();
        std::fs::write(bundle.join("Contents").join("Info.plist"), "<plist/>").unwrap();
        bundle
    }

    #[test]
    fn a_bundle_is_found_from_its_executable_and_a_loose_binary_is_not() {
        let root = temp_dir("bundle");
        let bundle = fake_bundle(&root);
        let exe = bundle.join("Contents").join("MacOS").join("caprock-app");
        assert_eq!(bundle_of(&exe), Some(bundle.clone()));
        assert_eq!(
            icon_of(&bundle),
            bundle.join("Contents").join("Resources").join("icon.icns")
        );
        // cargo run: target/debug/caprock-app.
        let loose = root.join("target").join("debug").join("caprock-app");
        assert_eq!(bundle_of(&loose), None);
        // The right shape without an Info.plist is not a bundle.
        let bare = root.join("Bare.app").join("Contents").join("MacOS");
        std::fs::create_dir_all(&bare).unwrap();
        assert_eq!(bundle_of(&bare.join("x")), None);
        // Nor is a Contents/MacOS outside an .app.
        let plain = root.join("Plain").join("Contents");
        std::fs::create_dir_all(plain.join("MacOS")).unwrap();
        std::fs::write(plain.join("Info.plist"), "").unwrap();
        assert_eq!(bundle_of(&plain.join("MacOS").join("x")), None);
        assert_eq!(bundle_of(Path::new("caprock-app")), None);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn the_refresh_runs_once_per_version() {
        let root = temp_dir("version");
        let data = root.join("caprock");
        assert!(first_run_of(&data, "0.109.1"), "no record: refresh");
        assert!(!first_run_of(&data, "0.109.1"), "same version: nothing");
        assert!(!first_run_of(&data, "0.109.1"), "and again nothing");
        assert!(first_run_of(&data, "0.110.0"), "updated: refresh");
        assert!(!first_run_of(&data, "0.110.0"));
        assert!(first_run_of(&data, "0.109.1"), "a downgrade differs too");
        assert_eq!(
            std::fs::read_to_string(data.join(LAST_RUN)).unwrap(),
            "0.109.1"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn an_unwritable_record_never_refreshes() {
        let root = temp_dir("unwritable");
        // The data directory's path is a file, so nothing can be written.
        let data = root.join("file");
        std::fs::write(&data, "").unwrap();
        assert!(!first_run_of(&data, "1.0.0"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn touch_moves_a_bundle_mtime_forward() {
        use std::time::{Duration, SystemTime};
        let root = temp_dir("touch");
        let bundle = fake_bundle(&root);
        let old = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        std::fs::File::open(&bundle)
            .unwrap()
            .set_modified(old)
            .unwrap();
        touch(&bundle).unwrap();
        let now = std::fs::metadata(&bundle).unwrap().modified().unwrap();
        assert!(now > old + Duration::from_secs(86_400));
        let _ = std::fs::remove_dir_all(root);
    }
}
