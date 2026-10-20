//! The app's own log: `<data dir>/app.log`, a few lines a day at most, on
//! this machine only (rule 4: nothing is sent anywhere). It records why the
//! window had to recover by itself — the WebView's content process ended, a
//! page that never finished loading, the page's own crash screen — so the
//! next "the window went white" can be answered from the file rather than
//! guessed. `app.log.1` keeps the previous file once it passes `MAX_BYTES`.

use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
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

static PAGE_LINES: AtomicUsize = AtomicUsize::new(0);

/// One line, with the time in UTC. Never fails: a log that cannot be
/// written is no reason to stop recovering.
pub fn line(data_dir: &Path, msg: &str) {
    let text = format!("{} {}\n", utc(SystemTime::now()), clean(msg));
    let _ = append(data_dir, &text);
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
