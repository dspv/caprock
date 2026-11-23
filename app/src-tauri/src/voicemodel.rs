//! The voice model for dictation on Windows and Linux (ADR-103): which files
//! exist, where they live, and their download — only on the user's click in
//! Settings → Voice input, from huggingface.co, each file's SHA-256 checked
//! against the hashes compiled in below before it counts as installed.
//!
//! Rule 4: this is the only outbound call voice input makes. It sends a
//! plain GET for a public file (no identifier, no audio, no text); the
//! download goes to a `.part` file that is renamed only once its size and
//! hash match, so a cut-off or tampered download never looks installed.
//! Nothing downloads in the background, on start, or again by itself.
//!
//! Two speech models are offered and one is installed at a time: *Accurate*
//! (`ggml-small-q5_1.bin`, the default) and *Fast* (`ggml-base.bin`).
//! Either comes with the Silero speech detector (`ggml-silero-v5.1.2.bin`,
//! under 1 MB) that splits the dictation at pauses. They are stored under
//! the app's local data folder (Tauri's `app_local_data_dir`):
//! `%LOCALAPPDATA%\dev.caprock.app\voice\` on Windows,
//! `~/.local/share/dev.caprock.app/voice/` on Linux.
//!
//! The Mac never downloads anything: Apple's recogniser answers there
//! (ADR-102), and every command here says so.
// Downloading is Windows' and Linux's; on a Mac only the refusals and the
// tests use this module.
#![cfg_attr(target_os = "macos", allow(dead_code))]

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, Runtime};

/// One file voice input needs: where it comes from and what it must be.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Spec {
    pub file: &'static str,
    /// The Hugging Face repository and the commit the hash was read at.
    pub repo: &'static str,
    pub rev: &'static str,
    pub size: u64,
    /// The SHA-256 of the file, as the repository's LFS pointer names it.
    pub sha256: &'static str,
}

impl Spec {
    /// Where it is downloaded from: the pinned commit, never `main`.
    pub fn url(&self) -> String {
        format!(
            "https://huggingface.co/{}/resolve/{}/{}",
            self.repo, self.rev, self.file
        )
    }
}

/// A speech model the user can pick.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Model {
    /// `small` or `base`: what the page and the settings call it.
    pub id: &'static str,
    pub spec: Spec,
}

// Read from the official repositories' LFS pointers on 2026-11-23
// (huggingface.co/api/models/<repo>/tree/main, `lfs.oid` and `size`); the
// same hashes the research runs measured (ADR-103).
const WHISPER_REPO: &str = "ggerganov/whisper.cpp";
const WHISPER_REV: &str = "5359861c739e955e79d9a303bcbc70fb988958b1";

/// Accurate: whisper small, 5-bit quantised. The default.
pub const SMALL: Model = Model {
    id: "small",
    spec: Spec {
        file: "ggml-small-q5_1.bin",
        repo: WHISPER_REPO,
        rev: WHISPER_REV,
        size: 190_085_487,
        sha256: "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb",
    },
};

/// Fast: whisper base. Misses more words, more often in Russian.
pub const BASE: Model = Model {
    id: "base",
    spec: Spec {
        file: "ggml-base.bin",
        repo: WHISPER_REPO,
        rev: WHISPER_REV,
        size: 147_951_465,
        sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
    },
};

/// The Silero speech detector whisper.cpp reads (its README's VAD model).
pub const VAD: Spec = Spec {
    file: "ggml-silero-v5.1.2.bin",
    repo: "ggml-org/whisper-vad",
    rev: "9ffd54a1e1ee413ddf265af9913beaf518d1639b",
    size: 885_098,
    sha256: "29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf",
};

/// The models, the default first.
pub const MODELS: [Model; 2] = [SMALL, BASE];

pub fn model(id: &str) -> Option<Model> {
    MODELS.into_iter().find(|m| m.id == id)
}

/// Whether this build offers offline voice at all: Windows and Linux.
pub const fn offered() -> bool {
    !cfg!(target_os = "macos")
}

/// The folder the files live in.
pub fn dir<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path()
        .app_local_data_dir()
        .ok()
        .map(|d| d.join("voice"))
}

/// A file is there when it has exactly its size: its hash was checked on
/// the way in, and reading 190 MB again on every look would be work for
/// nothing (whisper.cpp refuses a damaged file when it loads it).
fn present(dir: &Path, spec: &Spec) -> bool {
    fs::metadata(dir.join(spec.file)).is_ok_and(|m| m.is_file() && m.len() == spec.size)
}

/// The installed model: a speech model and the detector both present.
pub fn installed_in(dir: &Path) -> Option<Model> {
    if !present(dir, &VAD) {
        return None;
    }
    MODELS.into_iter().find(|m| present(dir, &m.spec))
}

/// The two files a dictation loads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Files {
    pub model: PathBuf,
    pub vad: PathBuf,
}

pub fn files_in(dir: &Path) -> Option<Files> {
    installed_in(dir).map(|m| Files {
        model: dir.join(m.spec.file),
        vad: dir.join(VAD.file),
    })
}

/// What has to be fetched to install `m`: the detector first when it is
/// missing (it is small), then the model.
pub fn needed(dir: &Path, m: &Model) -> Vec<Spec> {
    let mut v = Vec::new();
    if !present(dir, &VAD) {
        v.push(VAD);
    }
    if !present(dir, &m.spec) {
        v.push(m.spec);
    }
    v
}

/// Why a download failed, as the page explains it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Fail {
    /// The file did not match its SHA-256 (or its size): deleted.
    Checksum,
    /// No connection, a refusal, or the server cut it off.
    Network,
    /// It could not be written: a full disk, no permission.
    Disk,
}

/// One file on its way in: written to `<file>.part` and hashed as the bytes
/// arrive; `finish` renames it only when size and hash match.
pub struct Incoming {
    spec: Spec,
    part: PathBuf,
    out: File,
    hash: Sha256,
    got: u64,
}

impl Incoming {
    pub fn create(dir: &Path, spec: Spec) -> Result<Self, Fail> {
        fs::create_dir_all(dir).map_err(|_| Fail::Disk)?;
        let part = dir.join(format!("{}.part", spec.file));
        let out = File::create(&part).map_err(|_| Fail::Disk)?;
        Ok(Self {
            spec,
            part,
            out,
            hash: Sha256::new(),
            got: 0,
        })
    }

    /// Bytes from the wire. More than the file's size is already wrong.
    pub fn push(&mut self, bytes: &[u8]) -> Result<(), Fail> {
        self.got += bytes.len() as u64;
        if self.got > self.spec.size {
            return Err(Fail::Checksum);
        }
        self.hash.update(bytes);
        self.out.write_all(bytes).map_err(|_| Fail::Disk)
    }

    pub fn received(&self) -> u64 {
        self.got
    }

    /// Checks the whole file and puts it in place; on any mismatch the
    /// part is deleted and nothing is installed.
    pub fn finish(self) -> Result<PathBuf, Fail> {
        let Incoming {
            spec,
            part,
            mut out,
            hash,
            got,
        } = self;
        let flushed = out.flush().and_then(|_| out.sync_all());
        drop(out);
        if flushed.is_err() {
            let _ = fs::remove_file(&part);
            return Err(Fail::Disk);
        }
        let hex = hex_of(&hash.finalize());
        if got != spec.size || hex != spec.sha256 {
            let _ = fs::remove_file(&part);
            return Err(Fail::Checksum);
        }
        let dest = part.with_file_name(spec.file);
        if fs::rename(&part, &dest).is_err() {
            let _ = fs::remove_file(&part);
            return Err(Fail::Disk);
        }
        Ok(dest)
    }

    /// Cancelled or failed: the part goes.
    pub fn abort(self) {
        let part = self.part.clone();
        drop(self);
        let _ = fs::remove_file(part);
    }
}

fn hex_of(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Whether a file on disk is exactly `spec`: size, then SHA-256.
pub fn verify_file(path: &Path, spec: &Spec) -> Result<(), Fail> {
    let meta = fs::metadata(path).map_err(|_| Fail::Disk)?;
    if meta.len() != spec.size {
        return Err(Fail::Checksum);
    }
    let mut f = File::open(path).map_err(|_| Fail::Disk)?;
    let mut h = Sha256::new();
    std::io::copy(&mut f, &mut h).map_err(|_| Fail::Disk)?;
    if hex_of(&h.finalize()) == spec.sha256 {
        Ok(())
    } else {
        Err(Fail::Checksum)
    }
}

/// Deletes every file voice input put in `dir`: models, the detector and
/// any part left over.
pub fn remove_all(dir: &Path) -> std::io::Result<()> {
    let names: Vec<String> = MODELS
        .iter()
        .map(|m| m.spec.file)
        .chain([VAD.file])
        .flat_map(|f| [f.to_string(), format!("{f}.part")])
        .collect();
    for n in names {
        match fs::remove_file(dir.join(&n)) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

/// The other speech model, removed once `keep` is in: one at a time.
fn remove_others(dir: &Path, keep: &Model) {
    for m in MODELS.iter().filter(|m| m.id != keep.id) {
        let _ = fs::remove_file(dir.join(m.spec.file));
    }
}

/// Where a download stands. A pure state machine: the transitions are the
/// functions below, and the page sees it through `Status`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Phase {
    Idle,
    Downloading {
        model: &'static str,
        done: u64,
        total: u64,
    },
    /// The last attempt failed; *Try again* starts over.
    Failed {
        model: &'static str,
        error: Fail,
    },
}

impl Phase {
    /// A click on Download: from anything but a download under way.
    pub fn begin(&self, model: &'static str, total: u64) -> Option<Phase> {
        match self {
            Phase::Downloading { .. } => None,
            _ => Some(Phase::Downloading {
                model,
                done: 0,
                total,
            }),
        }
    }

    pub fn progress(&self, add: u64) -> Phase {
        match *self {
            Phase::Downloading { model, done, total } => Phase::Downloading {
                model,
                done: (done + add).min(total),
                total,
            },
            ref p => p.clone(),
        }
    }

    /// How it ended: `Ok` installed (idle, nothing to say), `Err(None)`
    /// cancelled (idle too), `Err(Some(f))` failed with its reason.
    pub fn end(&self, how: Result<(), Option<Fail>>) -> Phase {
        let Phase::Downloading { model, .. } = *self else {
            return self.clone();
        };
        match how {
            Ok(()) | Err(None) => Phase::Idle,
            Err(Some(error)) => Phase::Failed { model, error },
        }
    }

    pub fn downloading(&self) -> bool {
        matches!(self, Phase::Downloading { .. })
    }
}

/// The download's state, one per app (managed by Tauri).
#[derive(Default)]
pub struct VoiceModels {
    phase: Mutex<PhaseCell>,
    cancel: Arc<AtomicBool>,
}

struct PhaseCell(Phase);

impl Default for PhaseCell {
    fn default() -> Self {
        PhaseCell(Phase::Idle)
    }
}

impl VoiceModels {
    pub fn phase(&self) -> Phase {
        self.phase
            .lock()
            .map(|p| p.0.clone())
            .unwrap_or(Phase::Idle)
    }

    fn set(&self, f: impl FnOnce(&Phase) -> Phase) {
        if let Ok(mut p) = self.phase.lock() {
            p.0 = f(&p.0);
        }
    }

    pub fn downloading(&self) -> bool {
        self.phase().downloading()
    }
}

/// One model as the settings list it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ModelInfo {
    pub id: &'static str,
    pub file: &'static str,
    /// The model's size plus the detector's, in bytes: what a download costs.
    pub bytes: u64,
}

/// What Settings → Voice input shows.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Status {
    /// Offline voice exists here: Windows and Linux.
    pub offered: bool,
    /// This processor can run the model (x86-64 needs AVX2, FMA and F16C).
    pub cpu_ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub models: Vec<ModelInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub download: Option<Progress>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<Failure>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Progress {
    pub model: &'static str,
    pub done: u64,
    pub total: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Failure {
    pub model: &'static str,
    pub error: Fail,
}

/// The status for `dir` (None: no data folder) in `phase`.
pub fn status_of(dir: Option<&Path>, phase: &Phase) -> Status {
    let models = MODELS
        .iter()
        .map(|m| ModelInfo {
            id: m.id,
            file: m.spec.file,
            bytes: m.spec.size + VAD.size,
        })
        .collect();
    if !offered() {
        return Status {
            offered: false,
            cpu_ok: false,
            dir: None,
            installed: None,
            path: None,
            models,
            download: None,
            error: None,
        };
    }
    let installed = dir.and_then(installed_in);
    Status {
        offered: true,
        cpu_ok: cpu_ok(),
        dir: dir.map(|d| d.display().to_string()),
        installed: installed.map(|m| m.id),
        path: installed
            .zip(dir)
            .map(|(m, d)| d.join(m.spec.file).display().to_string()),
        models,
        download: match *phase {
            Phase::Downloading { model, done, total } => Some(Progress { model, done, total }),
            _ => None,
        },
        error: match *phase {
            Phase::Failed { model, error } => Some(Failure { model, error }),
            _ => None,
        },
    }
}

/// Whether this processor runs the engine as built: on x86-64 ggml is
/// compiled for AVX2, FMA and F16C (.cargo/config.toml), which a processor
/// from before about 2013 lacks; it would crash rather than refuse.
pub fn cpu_ok() -> bool {
    #[cfg(target_arch = "x86_64")]
    {
        std::arch::is_x86_feature_detected!("avx2")
            && std::arch::is_x86_feature_detected!("fma")
            && std::arch::is_x86_feature_detected!("f16c")
    }
    #[cfg(not(target_arch = "x86_64"))]
    {
        true
    }
}

#[tauri::command]
pub fn voice_model_status<R: Runtime>(
    app: AppHandle<R>,
    models: tauri::State<'_, VoiceModels>,
) -> Status {
    status_of(dir(&app).as_deref(), &models.phase())
}

/// Starts downloading `model` and returns at once; the page follows it with
/// `voice_model_status`. Refused on a Mac, for an unknown model, without a
/// data folder, and while a download is under way.
#[tauri::command]
pub fn voice_model_download<R: Runtime>(
    app: AppHandle<R>,
    models: tauri::State<'_, VoiceModels>,
    model: String,
) -> Result<(), String> {
    if !offered() {
        return Err("voice models are for Windows and Linux".into());
    }
    let m = self::model(&model).ok_or_else(|| format!("no such model: {model}"))?;
    let dir = dir(&app).ok_or("no data folder")?;
    let todo = needed(&dir, &m);
    let total = todo.iter().map(|s| s.size).sum();
    let mut started = false;
    models.set(|p| match p.begin(m.id, total) {
        Some(next) => {
            started = true;
            next
        }
        None => p.clone(),
    });
    if !started {
        return Err("a download is already under way".into());
    }
    models.cancel.store(false, Ordering::SeqCst);
    let cancel = models.cancel.clone();
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let how = fetch_all(&handle, &dir, &todo, &cancel).await;
        if how.is_ok() {
            remove_others(&dir, &m);
        }
        handle.state::<VoiceModels>().set(|p| p.end(how));
    });
    Ok(())
}

/// Stops the download under way; what was fetched of the current file is
/// deleted.
#[tauri::command]
pub fn voice_model_cancel(models: tauri::State<'_, VoiceModels>) {
    models.cancel.store(true, Ordering::SeqCst);
}

/// Deletes the model and the detector; voice input then offers the
/// download again. A dictation under way is ended first.
#[tauri::command]
pub fn voice_model_remove<R: Runtime>(
    app: AppHandle<R>,
    models: tauri::State<'_, VoiceModels>,
) -> Result<(), String> {
    if !offered() {
        return Err("voice models are for Windows and Linux".into());
    }
    models.cancel.store(true, Ordering::SeqCst);
    #[cfg(not(target_os = "macos"))]
    crate::dictate_whisper::unload_now();
    let dir = dir(&app).ok_or("no data folder")?;
    models.set(|p| {
        if p.downloading() {
            p.clone()
        } else {
            Phase::Idle
        }
    });
    remove_all(&dir).map_err(|e| format!("could not delete the voice model: {e}"))
}

/// Shows the installed model in the file manager.
#[tauri::command]
pub fn voice_model_reveal<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    if !offered() {
        return Err("voice models are for Windows and Linux".into());
    }
    let dir = dir(&app).ok_or("no data folder")?;
    let m = installed_in(&dir).ok_or("no voice model is installed")?;
    app.opener()
        .reveal_item_in_dir(dir.join(m.spec.file))
        .map_err(|e| e.to_string())
}

/// Fetches each file in turn, adding to the progress as bytes arrive.
async fn fetch_all<R: Runtime>(
    app: &AppHandle<R>,
    dir: &Path,
    todo: &[Spec],
    cancel: &AtomicBool,
) -> Result<(), Option<Fail>> {
    // reqwest is built on rustls without a provider, as the updater's is;
    // whichever runs first installs ring.
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    let client = reqwest::Client::builder()
        .user_agent("Caprock")
        .connect_timeout(std::time::Duration::from_secs(20))
        .read_timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|_| Some(Fail::Network))?;
    for spec in todo {
        let mut resp = client
            .get(spec.url())
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|_| Some(Fail::Network))?;
        let mut file = Incoming::create(dir, *spec).map_err(Some)?;
        loop {
            if cancel.load(Ordering::SeqCst) {
                file.abort();
                return Err(None);
            }
            match resp.chunk().await {
                Ok(Some(bytes)) => {
                    if let Err(f) = file.push(&bytes) {
                        file.abort();
                        return Err(Some(f));
                    }
                    let n = bytes.len() as u64;
                    app.state::<VoiceModels>().set(|p| p.progress(n));
                }
                Ok(None) => break,
                Err(_) => {
                    file.abort();
                    return Err(Some(Fail::Network));
                }
            }
        }
        if file.received() != spec.size {
            // The server ended early: a cut-off file, not a forged one.
            file.abort();
            return Err(Some(Fail::Network));
        }
        file.finish().map_err(Some)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh folder under the system's temp dir, never the real data dir.
    fn scratch(name: &str) -> PathBuf {
        let d =
            std::env::temp_dir().join(format!("caprock-voicemodel-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    /// A small stand-in model: its bytes, and a spec whose hash is theirs.
    fn fake(bytes: &[u8]) -> Spec {
        let mut h = Sha256::new();
        h.update(bytes);
        let hex: &'static str = Box::leak(hex_of(&h.finalize()).into_boxed_str());
        Spec {
            file: "ggml-fake.bin",
            repo: "x/y",
            rev: "0",
            size: bytes.len() as u64,
            sha256: hex,
        }
    }

    #[test]
    fn the_pinned_files_are_the_official_ones() {
        assert_eq!(
            SMALL.spec.url(),
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-small-q5_1.bin"
        );
        assert!(VAD
            .url()
            .starts_with("https://huggingface.co/ggml-org/whisper-vad/resolve/"));
        for s in [SMALL.spec, BASE.spec, VAD] {
            assert_eq!(s.sha256.len(), 64, "{}", s.file);
            assert!(s
                .sha256
                .chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
            assert!(s.url().starts_with("https://huggingface.co/"));
            assert!(
                !s.url().contains("/main/"),
                "pinned to a commit: {}",
                s.file
            );
        }
        assert_eq!(MODELS[0], SMALL, "Accurate is the default");
        assert_eq!(model("base"), Some(BASE));
        assert_eq!(model("tiny"), None);
        assert_eq!(model("../x"), None);
    }

    #[test]
    fn a_file_that_matches_is_installed_and_one_that_does_not_is_deleted() {
        let dir = scratch("ok");
        let body = b"a whisper model, as far as this test cares".repeat(100);
        let spec = fake(&body);
        let mut f = Incoming::create(&dir, spec).unwrap();
        for chunk in body.chunks(7) {
            f.push(chunk).unwrap();
        }
        assert!(dir.join("ggml-fake.bin.part").exists());
        let dest = f.finish().unwrap();
        assert_eq!(dest, dir.join("ggml-fake.bin"));
        assert!(!dir.join("ggml-fake.bin.part").exists());
        assert_eq!(verify_file(&dest, &spec), Ok(()));

        // One flipped byte: same size, wrong hash.
        let dir = scratch("bad");
        let mut tampered = body.clone();
        tampered[10] ^= 1;
        let mut f = Incoming::create(&dir, spec).unwrap();
        f.push(&tampered).unwrap();
        assert_eq!(f.finish(), Err(Fail::Checksum));
        assert!(!dir.join("ggml-fake.bin").exists());
        assert!(!dir.join("ggml-fake.bin.part").exists());

        // Cut short: the size is wrong, nothing installed.
        let mut f = Incoming::create(&dir, spec).unwrap();
        f.push(&body[..body.len() - 1]).unwrap();
        assert_eq!(f.finish(), Err(Fail::Checksum));
        assert!(!dir.join("ggml-fake.bin").exists());

        // Longer than it should be: refused as it arrives.
        let mut f = Incoming::create(&dir, spec).unwrap();
        f.push(&body).unwrap();
        assert_eq!(f.push(b"x"), Err(Fail::Checksum));
        f.abort();
        assert!(!dir.join("ggml-fake.bin.part").exists());
    }

    #[test]
    fn a_file_on_disk_is_checked_by_size_then_hash() {
        let dir = scratch("verify");
        let body = b"0123456789".repeat(50);
        let spec = fake(&body);
        let p = dir.join("m.bin");
        fs::write(&p, &body).unwrap();
        assert_eq!(verify_file(&p, &spec), Ok(()));
        fs::write(&p, b"short").unwrap();
        assert_eq!(verify_file(&p, &spec), Err(Fail::Checksum));
        let mut same_len = body.clone();
        same_len[0] = b'X';
        fs::write(&p, &same_len).unwrap();
        assert_eq!(verify_file(&p, &spec), Err(Fail::Checksum));
        assert_eq!(verify_file(&dir.join("none"), &spec), Err(Fail::Disk));
    }

    /// A stand-in for a downloaded file: the right length, sparse.
    fn place(dir: &Path, spec: &Spec) {
        let f = File::create(dir.join(spec.file)).unwrap();
        f.set_len(spec.size).unwrap();
    }

    #[test]
    fn installed_means_a_model_and_the_detector_at_their_sizes() {
        let dir = scratch("installed");
        assert_eq!(installed_in(&dir), None);
        assert_eq!(needed(&dir, &SMALL), vec![VAD, SMALL.spec]);
        place(&dir, &BASE.spec);
        assert_eq!(installed_in(&dir), None, "no detector yet");
        place(&dir, &VAD);
        assert_eq!(installed_in(&dir), Some(BASE));
        assert_eq!(
            needed(&dir, &SMALL),
            vec![SMALL.spec],
            "the detector is kept"
        );
        assert_eq!(needed(&dir, &BASE), Vec::<Spec>::new());
        let files = files_in(&dir).unwrap();
        assert_eq!(files.model, dir.join("ggml-base.bin"));
        assert_eq!(files.vad, dir.join("ggml-silero-v5.1.2.bin"));
        // A part file is never installed; a wrong size is not either.
        fs::write(dir.join("ggml-small-q5_1.bin.part"), b"x").unwrap();
        fs::write(dir.join("ggml-small-q5_1.bin"), b"x").unwrap();
        assert_eq!(installed_in(&dir), Some(BASE));
        place(&dir, &SMALL.spec);
        assert_eq!(
            installed_in(&dir),
            Some(SMALL),
            "Accurate wins when both are in"
        );
        remove_others(&dir, &SMALL);
        assert!(!dir.join("ggml-base.bin").exists());
        remove_all(&dir).unwrap();
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
        // Removing twice is no error.
        remove_all(&dir).unwrap();
    }

    #[test]
    fn the_download_moves_through_its_states() {
        let idle = Phase::Idle;
        let d = idle.begin("small", 100).unwrap();
        assert!(d.downloading());
        assert_eq!(d.begin("base", 5), None, "one download at a time");
        let d = d.progress(40).progress(80);
        assert_eq!(
            d,
            Phase::Downloading {
                model: "small",
                done: 100,
                total: 100
            },
            "never past the total"
        );
        assert_eq!(d.end(Ok(())), Phase::Idle);
        assert_eq!(d.end(Err(None)), Phase::Idle, "a cancel is no failure");
        let failed = d.end(Err(Some(Fail::Checksum)));
        assert_eq!(
            failed,
            Phase::Failed {
                model: "small",
                error: Fail::Checksum
            }
        );
        // Try again starts over from a failure.
        assert!(failed.begin("small", 100).unwrap().downloading());
        // Progress or an end outside a download changes nothing.
        assert_eq!(idle.progress(5), Phase::Idle);
        assert_eq!(failed.end(Ok(())), failed);
    }

    #[test]
    fn the_status_names_the_folder_the_model_and_the_download() {
        let dir = scratch("status");
        let s = status_of(Some(&dir), &Phase::Idle);
        assert_eq!(s.models.len(), 2);
        assert_eq!(s.models[0].id, "small");
        assert_eq!(s.models[0].bytes, SMALL.spec.size + VAD.size);
        if offered() {
            assert!(s.offered);
            assert_eq!(s.installed, None);
            place(&dir, &VAD);
            place(&dir, &SMALL.spec);
            let s = status_of(
                Some(&dir),
                &Phase::Downloading {
                    model: "base",
                    done: 1,
                    total: 2,
                },
            );
            assert_eq!(s.installed, Some("small"));
            assert!(s.path.unwrap().ends_with("ggml-small-q5_1.bin"));
            assert_eq!(s.download.unwrap().done, 1);
            let s = status_of(
                Some(&dir),
                &Phase::Failed {
                    model: "base",
                    error: Fail::Network,
                },
            );
            let json = serde_json::to_value(&s).unwrap();
            assert_eq!(json["error"]["error"], "network");
        } else {
            assert!(!s.offered);
            assert_eq!(s.dir, None);
        }
    }
}
