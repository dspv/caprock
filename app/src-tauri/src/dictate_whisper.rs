//! Dictation on Windows and Linux (ADR-104; `dictate.rs` says what the page
//! sees): the microphone through cpal, recognised by whisper.cpp in this
//! process on the CPU. Nothing is recorded to disk and nothing is sent: the
//! audio lives in memory for as long as a piece takes to transcribe.
//!
//! One thread per dictation. It opens the default microphone, says
//! `Listening`, loads the model (kept in memory for `IDLE_UNLOAD` after the
//! last dictation, then dropped), and every 150 ms moves what the
//! microphone heard into a 16 kHz buffer. whisper.cpp's speech detector
//! finds the pauses in it (`next_cut`); each piece that ends at one is
//! transcribed with the window cut to its length (`audio_ctx`) and the words
//! so far go to the page as `Partial`. The release turns the microphone off
//! at once and transcribes the last piece — the page says *Finishing…* —
//! then sends `Final` and `End`. A cancel or a newer dictation ends it
//! within a poll, aborting a transcription under way.

use crate::dictate::{join_heard, Event, Sink};
use crate::dictate_offline::{
    audio_ctx, clean_piece, next_cut, pad_short, threads, whisper_lang, Resampler, Speech,
    IDLE_UNLOAD, MAX_WINDOW, RATE,
};
use crate::voicemodel::Files;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{ErrorKind, FromSample, Sample, SampleFormat, SizedSample};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::Duration;
use whisper_rs::{
    FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperVadContext,
    WhisperVadContextParams, WhisperVadParams,
};

const LISTEN: u8 = 0;
const FINISH: u8 = 1;
const CANCEL: u8 = 2;
const SUPERSEDED: u8 = 3;

/// How often the dictation thread looks at what the microphone heard.
const POLL: Duration = Duration::from_millis(150);
/// New audio before the detector looks again, and the least it looks at.
const VAD_EVERY: usize = RATE as usize * 2 / 5;
const VAD_MIN: usize = RATE as usize;
/// Below this, a stretch whisper calls "no speech" is dropped.
const NO_SPEECH: f32 = 0.6;

struct Running {
    id: u64,
    ctl: Arc<AtomicU8>,
}

struct Loaded {
    model: PathBuf,
    ctx: Arc<WhisperContext>,
    vad: Arc<Mutex<WhisperVadContext>>,
}

static ACTIVE: Mutex<Option<Running>> = Mutex::new(None);
static LOADED: Mutex<Option<Loaded>> = Mutex::new(None);
/// Bumped at each dictation's end: an unload scheduled before a later
/// dictation finds it changed and leaves the model in.
static USED: AtomicU64 = AtomicU64::new(0);

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Starts dictation `id` for the chip's `lang` with the installed `files`;
/// a dictation already running ends as superseded.
pub fn start(id: u64, lang: String, sink: Sink, files: Files) {
    let ctl = Arc::new(AtomicU8::new(LISTEN));
    if let Some(old) = lock(&ACTIVE).replace(Running {
        id,
        ctl: ctl.clone(),
    }) {
        old.ctl.store(SUPERSEDED, Ordering::SeqCst);
    }
    let spawned = std::thread::Builder::new()
        .name("caprock-dictate".into())
        .spawn({
            let sink = sink.clone();
            move || {
                let (fin, error) = run(id, &lang, &sink, &files, &ctl);
                {
                    let mut a = lock(&ACTIVE);
                    if a.as_ref().is_some_and(|r| r.id == id) {
                        *a = None;
                    }
                }
                if let Some(text) = fin {
                    sink(Event::Final { id, text });
                }
                sink(Event::End { id, error });
                schedule_unload();
            }
        });
    if spawned.is_err() {
        sink(Event::End {
            id,
            error: Some("failed"),
        });
    }
}

/// Stops dictation `id`: with `cancel`, nothing more but the end; else the
/// last piece is transcribed and sent as the final words.
pub fn stop(id: u64, cancel: bool) {
    if let Some(r) = lock(&ACTIVE).as_ref().filter(|r| r.id == id) {
        let _ = r.ctl.compare_exchange(
            LISTEN,
            if cancel { CANCEL } else { FINISH },
            Ordering::SeqCst,
            Ordering::SeqCst,
        );
        if cancel {
            r.ctl.store(CANCEL, Ordering::SeqCst);
        }
    }
}

/// Drops the model now (Remove in Settings), ending a dictation first.
pub fn unload_now() {
    if let Some(r) = lock(&ACTIVE).as_ref() {
        r.ctl.store(CANCEL, Ordering::SeqCst);
    }
    lock(&LOADED).take();
}

/// The model leaves memory `IDLE_UNLOAD` after the last dictation, unless
/// another one used it since. A sleeping thread, nothing more.
fn schedule_unload() {
    let mark = USED.fetch_add(1, Ordering::SeqCst) + 1;
    let _ = std::thread::Builder::new()
        .name("caprock-dictate-idle".into())
        .spawn(move || {
            std::thread::sleep(IDLE_UNLOAD);
            if USED.load(Ordering::SeqCst) == mark && lock(&ACTIVE).is_none() {
                lock(&LOADED).take();
            }
        });
}

/// The model and the detector, loaded once and shared until unloaded.
fn load(
    files: &Files,
    n_threads: i32,
) -> Result<(Arc<WhisperContext>, Arc<Mutex<WhisperVadContext>>), ()> {
    static HOOKS: OnceLock<()> = OnceLock::new();
    // whisper.cpp's own log lines go nowhere rather than to stderr.
    HOOKS.get_or_init(whisper_rs::install_logging_hooks);
    let mut l = lock(&LOADED);
    if let Some(m) = l.as_ref().filter(|m| m.model == files.model) {
        return Ok((m.ctx.clone(), m.vad.clone()));
    }
    l.take();
    let mut cp = WhisperContextParameters::default();
    cp.use_gpu(false);
    let ctx = WhisperContext::new_with_params(&files.model, cp).map_err(|_| ())?;
    let mut vp = WhisperVadContextParams::default();
    vp.set_n_threads(n_threads.min(2));
    vp.set_use_gpu(false);
    let vad_path = files.vad.to_str().ok_or(())?;
    let vad = WhisperVadContext::new(vad_path, vp).map_err(|_| ())?;
    let loaded = Loaded {
        model: files.model.clone(),
        ctx: Arc::new(ctx),
        vad: Arc::new(Mutex::new(vad)),
    };
    let out = (loaded.ctx.clone(), loaded.vad.clone());
    *l = Some(loaded);
    Ok(out)
}

/// The microphone, open: its samples land in `heard` at its own rate.
struct Mic {
    _stream: cpal::Stream,
    rate: u32,
    channels: usize,
    heard: Arc<Mutex<Vec<f32>>>,
    lost: Arc<AtomicBool>,
}

fn mic_error(kind: ErrorKind) -> &'static str {
    match kind {
        ErrorKind::PermissionDenied => "mic-denied",
        _ => "no-microphone",
    }
}

fn open_mic() -> Result<Mic, &'static str> {
    let host = cpal::default_host();
    let device = host.default_input_device().ok_or("no-microphone")?;
    let config = device
        .default_input_config()
        .map_err(|e| mic_error(e.kind()))?;
    let heard = Arc::new(Mutex::new(Vec::<f32>::with_capacity(RATE as usize)));
    let lost = Arc::new(AtomicBool::new(false));
    let rate = config.sample_rate();
    let channels = usize::from(config.channels());
    let format = config.sample_format();
    let stream_config = config.config();
    fn build<T>(
        device: &cpal::Device,
        config: cpal::StreamConfig,
        heard: Arc<Mutex<Vec<f32>>>,
        lost: Arc<AtomicBool>,
    ) -> Result<cpal::Stream, cpal::Error>
    where
        T: SizedSample,
        f32: FromSample<T>,
    {
        device.build_input_stream::<T, _, _>(
            config,
            move |data: &[T], _: &cpal::InputCallbackInfo| {
                lock(&heard).extend(data.iter().map(|&s| f32::from_sample(s)));
            },
            move |e: cpal::Error| {
                if matches!(
                    e.kind(),
                    ErrorKind::DeviceNotAvailable
                        | ErrorKind::HostUnavailable
                        | ErrorKind::StreamInvalidated
                        | ErrorKind::PermissionDenied
                ) {
                    lost.store(true, Ordering::SeqCst);
                }
            },
            None,
        )
    }
    let (h, l) = (heard.clone(), lost.clone());
    let stream = match format {
        SampleFormat::F32 => build::<f32>(&device, stream_config, h, l),
        SampleFormat::I16 => build::<i16>(&device, stream_config, h, l),
        SampleFormat::U16 => build::<u16>(&device, stream_config, h, l),
        SampleFormat::I32 => build::<i32>(&device, stream_config, h, l),
        SampleFormat::U8 => build::<u8>(&device, stream_config, h, l),
        SampleFormat::I8 => build::<i8>(&device, stream_config, h, l),
        _ => return Err("no-microphone"),
    }
    .map_err(|e| mic_error(e.kind()))?;
    stream.play().map_err(|e| mic_error(e.kind()))?;
    Ok(Mic {
        _stream: stream,
        rate,
        channels,
        heard,
        lost,
    })
}

/// The dictation's thread: the final words (if any) and why it ended.
fn run(
    id: u64,
    tag: &str,
    sink: &Sink,
    files: &Files,
    ctl: &Arc<AtomicU8>,
) -> (Option<String>, Option<&'static str>) {
    let Some(lang) = whisper_lang(tag).filter(|l| whisper_rs::get_lang_id(l).is_some()) else {
        return (None, Some("language-unsupported"));
    };
    let mic = match open_mic() {
        Ok(m) => m,
        Err(code) => return (None, Some(code)),
    };
    sink(Event::Listening { id });
    let n_threads = threads(num_cpus::get_physical());
    let Ok((ctx, vad)) = load(files, n_threads) else {
        return (None, Some("model-failed"));
    };
    let mut rs = Resampler::new(mic.rate);
    let mut pipe = Pipeline::new(&ctx, &vad, &lang, n_threads, ctl);
    let mut error = None;
    let ended = |c: &AtomicU8| match c.load(Ordering::SeqCst) {
        CANCEL => Some(None),
        SUPERSEDED => Some(Some("superseded")),
        _ => None,
    };
    let drain = |rs: &mut Resampler| {
        let raw = std::mem::take(&mut *lock(&mic.heard));
        let mut out = Vec::with_capacity(raw.len() / 2);
        rs.push(&raw, mic.channels, &mut out);
        out
    };
    loop {
        std::thread::sleep(POLL);
        if let Some(e) = ended(ctl) {
            return (None, e);
        }
        if ctl.load(Ordering::SeqCst) == FINISH {
            break;
        }
        if mic.lost.load(Ordering::SeqCst) {
            error = Some("no-microphone");
            break;
        }
        let audio = drain(&mut rs);
        match pipe.feed(&audio) {
            Ok(true) => sink(Event::Partial {
                id,
                text: pipe.heard.clone(),
            }),
            Ok(false) => {}
            Err(()) => {
                if let Some(e) = ended(ctl) {
                    return (None, e);
                }
                error = Some("failed");
                break;
            }
        }
    }
    // Released: the microphone goes off now; the rest is transcribed.
    let audio = drain(&mut rs);
    drop(mic);
    if error.is_none() {
        pipe.pending.extend_from_slice(&audio);
        if pipe.finish().is_err() {
            if let Some(e) = ended(ctl) {
                return (None, e);
            }
            error = Some("failed");
        }
    }
    let heard = std::mem::take(&mut pipe.heard);
    if heard.trim().is_empty() {
        return (None, error.or(Some("no-speech")));
    }
    (Some(heard), error)
}

/// What one dictation has heard: the 16 kHz audio not yet transcribed, and
/// the words so far.
struct Pipeline<'a> {
    ctx: &'a WhisperContext,
    vad: &'a Mutex<WhisperVadContext>,
    lang: &'a str,
    n_threads: i32,
    ctl: &'a Arc<AtomicU8>,
    pending: Vec<f32>,
    /// How much of `pending` the detector last looked at.
    checked: usize,
    heard: String,
}

impl<'a> Pipeline<'a> {
    fn new(
        ctx: &'a WhisperContext,
        vad: &'a Mutex<WhisperVadContext>,
        lang: &'a str,
        n_threads: i32,
        ctl: &'a Arc<AtomicU8>,
    ) -> Self {
        Self {
            ctx,
            vad,
            lang,
            n_threads,
            ctl,
            pending: Vec::new(),
            checked: 0,
            heard: String::new(),
        }
    }

    /// More audio; once enough is new, the detector looks for a pause and
    /// the piece before it is transcribed. `Ok(true)`: the words grew.
    fn feed(&mut self, audio: &[f32]) -> Result<bool, ()> {
        self.pending.extend_from_slice(audio);
        let len = self.pending.len();
        if len < VAD_MIN || len < self.checked + VAD_EVERY {
            return Ok(false);
        }
        self.checked = len;
        let Some(speech) = detect(self.vad, &self.pending) else {
            return Ok(false);
        };
        let Some((cut, has_speech)) = next_cut(&speech, len) else {
            return Ok(false);
        };
        let piece: Vec<f32> = self.pending.drain(..cut).collect();
        self.checked = self.checked.saturating_sub(cut);
        if !has_speech {
            return Ok(false);
        }
        let t = transcribe(self.ctx, &piece, self.lang, self.n_threads, self.ctl)?;
        if t.is_empty() {
            return Ok(false);
        }
        self.heard = join_heard(&self.heard, &t);
        Ok(true)
    }

    /// After the release: whatever is left, a window at a time, when the
    /// detector hears speech in it (or cannot tell).
    fn finish(&mut self) -> Result<(), ()> {
        let pending = std::mem::take(&mut self.pending);
        if pending.is_empty() || detect(self.vad, &pending).is_some_and(|s| s.is_empty()) {
            return Ok(());
        }
        for chunk in pending.chunks(MAX_WINDOW) {
            let t = transcribe(self.ctx, chunk, self.lang, self.n_threads, self.ctl)?;
            self.heard = join_heard(&self.heard, &t);
        }
        Ok(())
    }
}

/// The stretches of speech in `audio`; None when the detector failed.
fn detect(vad: &Mutex<WhisperVadContext>, audio: &[f32]) -> Option<Vec<Speech>> {
    let mut p = WhisperVadParams::new();
    p.set_threshold(0.5);
    p.set_min_speech_duration(250);
    p.set_min_silence_duration(300);
    p.set_speech_pad(30);
    let segs = lock(vad).segments_from_samples(p, audio).ok()?;
    Some(segs.map(|s| Speech::from_centis(s.start, s.end)).collect())
}

/// One piece, in `lang`, with the window cut to its length.
fn transcribe(
    ctx: &WhisperContext,
    piece: &[f32],
    lang: &str,
    n_threads: i32,
    ctl: &Arc<AtomicU8>,
) -> Result<String, ()> {
    let audio = pad_short(piece.to_vec());
    // The CLI's defaults the research measured: beam search of 5.
    let mut p = FullParams::new(SamplingStrategy::BeamSearch {
        beam_size: 5,
        patience: -1.0,
    });
    p.set_n_threads(n_threads);
    p.set_language(Some(lang));
    p.set_translate(false);
    p.set_no_context(true);
    p.set_no_timestamps(true);
    p.set_print_special(false);
    p.set_print_progress(false);
    p.set_print_realtime(false);
    p.set_print_timestamps(false);
    p.set_suppress_blank(true);
    p.set_suppress_nst(true);
    p.set_audio_ctx(audio_ctx(piece.len()));
    let c = ctl.clone();
    p.set_abort_callback_safe(move || matches!(c.load(Ordering::SeqCst), CANCEL | SUPERSEDED));
    let mut state = ctx.create_state().map_err(|_| ())?;
    state.full(p, &audio).map_err(|_| ())?;
    let texts: Vec<String> = state
        .as_iter()
        .filter(|s| s.no_speech_probability() < NO_SPEECH)
        .filter_map(|s| s.to_str_lossy().ok().map(|t| t.into_owned()))
        .collect();
    Ok(clean_piece(texts.iter().map(String::as_str)))
}

/// A check by hand, never in CI: the whole pipeline (detector, cuts,
/// windows, transcription) on a 16 kHz mono 16-bit WAV, fed as the
/// microphone would feed it. Needs a model already on disk:
///
/// CAPROCK_VOICE_MODEL=…/ggml-base.bin CAPROCK_VOICE_VAD=…/ggml-silero-v5.1.2.bin
/// CAPROCK_VOICE_WAV=…/clip.wav CAPROCK_VOICE_LANG=en
/// cargo test --features offline-voice -- --ignored --nocapture pipeline_on_a_recording
#[cfg(test)]
mod tests {
    use super::*;

    fn wav_16k_mono(path: &str) -> Vec<f32> {
        let b = std::fs::read(path).expect("wav");
        let at = b.windows(4).position(|w| w == b"data").expect("data chunk") + 8;
        b[at..]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|c| f32::from(i16::from_le_bytes(*c)) / 32768.0)
            .collect()
    }

    #[test]
    #[ignore = "needs a downloaded model; run by hand"]
    fn pipeline_on_a_recording() {
        let var = |k: &str| std::env::var(k).unwrap_or_else(|_| panic!("{k}"));
        let files = Files {
            model: var("CAPROCK_VOICE_MODEL").into(),
            vad: var("CAPROCK_VOICE_VAD").into(),
        };
        let lang = var("CAPROCK_VOICE_LANG");
        // Several recordings (comma-separated) with a second's pause after
        // each, as a speaker pauses between sentences and before the release.
        let mut audio = Vec::new();
        for wav in var("CAPROCK_VOICE_WAV").split(',') {
            audio.extend(wav_16k_mono(wav));
            audio.extend(std::iter::repeat_n(0.0, RATE as usize));
        }
        let n_threads = threads(num_cpus::get_physical());
        let t0 = std::time::Instant::now();
        let (ctx, vad) = load(&files, n_threads).expect("load");
        eprintln!("loaded in {:?}, {n_threads} threads", t0.elapsed());
        let ctl = Arc::new(AtomicU8::new(LISTEN));
        let mut pipe = Pipeline::new(&ctx, &vad, &lang, n_threads, &ctl);
        let poll = RATE as usize * 150 / 1000;
        for chunk in audio.chunks(poll) {
            let t = std::time::Instant::now();
            if pipe.feed(chunk).expect("feed") {
                eprintln!("partial after {:?}: {}", t.elapsed(), pipe.heard);
            }
        }
        let t = std::time::Instant::now();
        pipe.finish().expect("finish");
        eprintln!("finished in {:?}: {}", t.elapsed(), pipe.heard);
        assert!(!pipe.heard.trim().is_empty());
    }
}
