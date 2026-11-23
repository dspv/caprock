//! The parts of offline dictation (ADR-103) that need neither a microphone
//! nor a model, so they are tested on every OS: turning the microphone's
//! audio into 16 kHz mono, deciding where to cut it into pieces at pauses,
//! how much of whisper's 30-second window a piece needs, the language code,
//! the thread count, and tidying what whisper wrote. The engine that uses
//! them is `dictate_whisper.rs`.
// Used by the engine on Windows and Linux; elsewhere by the tests alone.
#![cfg_attr(not(whisper), allow(dead_code))]

/// whisper.cpp's sample rate.
pub const RATE: u32 = 16_000;
const RATE_F: f64 = RATE as f64;

/// Samples in `ms` milliseconds at 16 kHz.
pub const fn ms(ms: usize) -> usize {
    ms * RATE as usize / 1000
}

/// The microphone's audio, whatever its rate and channels, as 16 kHz mono,
/// a buffer at a time. Downsampling averages the input samples that fall in
/// each output sample's span (a box filter, enough to keep speech from
/// aliasing); upsampling interpolates linearly.
pub struct Resampler {
    /// Input samples per output sample.
    step: f64,
    /// Input samples seen, as a position.
    seen: f64,
    // Downsampling: the span being averaged and where it ends.
    sum: f64,
    count: u32,
    edge: f64,
    // Upsampling: the previous input sample and the next output's position.
    prev: Option<f32>,
    next: f64,
}

impl Resampler {
    pub fn new(from_hz: u32) -> Self {
        let step = f64::from(from_hz.max(1)) / RATE_F;
        Self {
            step,
            seen: 0.0,
            sum: 0.0,
            count: 0,
            edge: step,
            prev: None,
            next: 0.0,
        }
    }

    /// Interleaved samples with `channels` channels; the 16 kHz mono ones
    /// they make are appended to `out`.
    pub fn push(&mut self, interleaved: &[f32], channels: usize, out: &mut Vec<f32>) {
        let ch = channels.max(1);
        for frame in interleaved.chunks(ch) {
            let x = frame.iter().sum::<f32>() / frame.len() as f32;
            self.one(x, out);
        }
    }

    fn one(&mut self, x: f32, out: &mut Vec<f32>) {
        if (self.step - 1.0).abs() < 1e-9 {
            out.push(x);
        } else if self.step > 1.0 {
            self.sum += f64::from(x);
            self.count += 1;
            self.seen += 1.0;
            if self.seen >= self.edge {
                out.push((self.sum / f64::from(self.count)) as f32);
                self.sum = 0.0;
                self.count = 0;
                self.edge += self.step;
            }
        } else {
            // This input sample sits at position `seen`; the outputs up to
            // it lie between the previous sample and this one.
            let at = self.seen;
            let prev = self.prev.unwrap_or(x);
            while self.next <= at {
                let t = (self.next - (at - 1.0)).clamp(0.0, 1.0) as f32;
                out.push(prev + (x - prev) * t);
                self.next += self.step;
            }
            self.prev = Some(x);
            self.seen += 1.0;
        }
    }
}

/// A stretch of speech the detector found, in 16 kHz samples.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Speech {
    pub start: usize,
    pub end: usize,
}

impl Speech {
    /// From whisper.cpp's detector, whose times are in centiseconds.
    pub fn from_centis(t0: f32, t1: f32) -> Self {
        let s = |t: f32| (f64::from(t.max(0.0)) * RATE_F / 100.0) as usize;
        Speech {
            start: s(t0),
            end: s(t1).max(s(t0)),
        }
    }
}

/// A pause at least this long ends a piece: shorter ones fall inside
/// sentences.
pub const PAUSE: usize = ms(600);
/// A piece is cut by force when it has run this long without such a pause.
pub const MAX_PIECE: usize = ms(20_000);
/// Never more than this in one piece: whisper's window is 30 s.
pub const MAX_WINDOW: usize = ms(28_000);
/// Audio with no speech in it is dropped once there is this much of it…
pub const SILENCE_DROP: usize = ms(3_000);
/// …keeping this much of its end, where speech may be starting.
pub const SILENCE_KEEP: usize = ms(500);
/// A gap between two stretches of speech that a forced cut may use.
const MIN_GAP: usize = ms(150);

/// Where to cut the audio waiting (`len` samples, `speech` the stretches
/// the detector found in it), and whether what comes before the cut holds
/// speech to transcribe. `None`: wait for more.
pub fn next_cut(speech: &[Speech], len: usize) -> Option<(usize, bool)> {
    let speech: Vec<Speech> = speech
        .iter()
        .filter(|s| s.end > s.start && s.start < len)
        .map(|s| Speech {
            start: s.start,
            end: s.end.min(len),
        })
        .collect();
    if speech.is_empty() {
        return (len >= SILENCE_DROP).then(|| (len - SILENCE_KEEP, false));
    }
    // The last stretch followed by a full pause: everything up to the
    // middle of that pause is a finished piece.
    for (i, s) in speech.iter().enumerate().rev() {
        let next = speech.get(i + 1).map_or(len, |n| n.start);
        let gap = next.saturating_sub(s.end);
        if gap >= PAUSE {
            let cut = (s.end + gap.min(PAUSE) / 2).min(MAX_WINDOW);
            return Some((cut, true));
        }
    }
    if len < MAX_PIECE {
        return None;
    }
    // Too long without a pause: the widest gap between words, else all of it.
    let widest = speech
        .windows(2)
        .map(|w| (w[1].start.saturating_sub(w[0].end), w[0].end, w[1].start))
        .filter(|&(gap, _, start)| gap >= MIN_GAP && start <= MAX_WINDOW)
        .max_by_key(|&(gap, _, _)| gap);
    let cut = widest.map_or(len, |(_, a, b)| (a + b) / 2);
    Some((cut.min(MAX_WINDOW), true))
}

/// Positions of whisper's encoder per second of audio: 1,500 for 30 s.
const CTX_PER_SECOND: usize = 50;
/// The full window.
pub const MAX_AUDIO_CTX: i32 = 1500;
/// The least window a piece gets, about 10 s. The research saw the decoder
/// retry and slow down on short pieces cut to their own length (ADR-103),
/// so a short phrase gets this much rather than exactly its length.
pub const MIN_AUDIO_CTX: i32 = 512;
/// Room past the piece's own length, so its last word is never cut off.
const CTX_MARGIN: usize = 32;

/// whisper's `audio_ctx` for a piece of `samples` samples (the CLI's
/// `-ac`): the encoder looks at the piece's length rather than a full 30 s
/// window, within the bounds above.
pub fn audio_ctx(samples: usize) -> i32 {
    let need = (samples * CTX_PER_SECOND).div_ceil(RATE as usize) + CTX_MARGIN;
    (need.min(MAX_AUDIO_CTX as usize) as i32).clamp(MIN_AUDIO_CTX, MAX_AUDIO_CTX)
}

/// whisper.cpp refuses less than about a second; a shorter piece is padded
/// with silence to this.
pub const MIN_SAMPLES: usize = ms(1_100);

pub fn pad_short(mut piece: Vec<f32>) -> Vec<f32> {
    if piece.len() < MIN_SAMPLES {
        piece.resize(MIN_SAMPLES, 0.0);
    }
    piece
}

/// The language whisper is told, from the chip's BCP-47 tag: `ru-RU` is
/// `ru`, `zh-Hant-TW` is `zh`. Never auto-detected (ADR-103).
pub fn whisper_lang(tag: &str) -> Option<String> {
    let base = tag
        .trim()
        .split(['-', '_'])
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    let ok = (2..=3).contains(&base.len()) && base.chars().all(|c| c.is_ascii_lowercase());
    ok.then_some(base)
}

/// The most threads whisper gets, however large the machine.
pub const MAX_THREADS: usize = 8;

/// Threads for whisper: one per physical core, at most `MAX_THREADS`.
pub fn threads(physical_cores: usize) -> i32 {
    physical_cores.clamp(1, MAX_THREADS) as i32
}

/// What whisper wrote for a piece, tidied: its segments joined, and the
/// tags it writes over silence or noise (`[BLANK_AUDIO]`, `(music)`)
/// dropped.
pub fn clean_piece<'a>(segments: impl IntoIterator<Item = &'a str>) -> String {
    let mut out = String::new();
    for seg in segments {
        let t = seg.trim();
        let tag = |o: char, c: char| t.starts_with(o) && t.ends_with(c);
        if t.is_empty() || tag('[', ']') || tag('(', ')') || tag('*', '*') {
            continue;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(t);
    }
    out
}

/// How long the loaded model stays in memory after the last dictation.
pub const IDLE_UNLOAD: std::time::Duration = std::time::Duration::from_secs(60);

#[cfg(test)]
mod tests {
    use super::*;

    fn resample(from: u32, channels: usize, input: &[f32], chunk: usize) -> Vec<f32> {
        let mut r = Resampler::new(from);
        let mut out = Vec::new();
        for c in input.chunks(chunk * channels) {
            r.push(c, channels, &mut out);
        }
        out
    }

    #[test]
    fn audio_becomes_16khz_mono_at_any_rate_and_buffer_size() {
        // One second in gives one second out, whatever the rate.
        for from in [8_000u32, 16_000, 22_050, 44_100, 48_000, 96_000] {
            let input = vec![0.25f32; from as usize];
            for chunk in [1usize, 480, 1024, 7777] {
                let out = resample(from, 1, &input, chunk);
                let diff = out.len().abs_diff(RATE as usize);
                assert!(
                    diff <= 1,
                    "{from} Hz in chunks of {chunk}: {} samples",
                    out.len()
                );
                // A constant stays that constant.
                assert!(out.iter().all(|&x| (x - 0.25).abs() < 1e-6), "{from}");
            }
        }
    }

    #[test]
    fn stereo_is_averaged_to_mono() {
        let input: Vec<f32> = [0.5f32, -0.5, 1.0, 0.0].repeat(4_000);
        let out = resample(16_000, 2, &input, 333);
        assert_eq!(out.len(), 8_000);
        assert_eq!(&out[..4], &[0.0, 0.5, 0.0, 0.5]);
    }

    #[test]
    fn downsampling_keeps_the_speech_band_and_damps_what_would_alias() {
        // 48 kHz: a 1 kHz tone survives; a 15 kHz one (which would fold to
        // 1 kHz) is mostly gone.
        let tone = |f: f64| -> Vec<f32> {
            (0..48_000)
                .map(|i| (2.0 * std::f64::consts::PI * f * i as f64 / 48_000.0).sin() as f32)
                .collect()
        };
        let rms = |v: &[f32]| (v.iter().map(|x| x * x).sum::<f32>() / v.len() as f32).sqrt();
        let low = resample(48_000, 1, &tone(1_000.0), 1024);
        let high = resample(48_000, 1, &tone(15_000.0), 1024);
        assert!(rms(&low) > 0.6, "1 kHz: {}", rms(&low));
        assert!(rms(&high) < 0.35, "15 kHz: {}", rms(&high));
    }

    #[test]
    fn upsampling_interpolates_between_samples() {
        let out = resample(8_000, 1, &[0.0, 1.0, 0.0, 1.0], 1);
        assert_eq!(out.len(), 7);
        assert_eq!(out[0], 0.0);
        assert!((out[1] - 0.5).abs() < 1e-6);
        assert_eq!(out[2], 1.0);
    }

    fn sp(a_ms: usize, b_ms: usize) -> Speech {
        Speech {
            start: ms(a_ms),
            end: ms(b_ms),
        }
    }

    #[test]
    fn a_piece_ends_at_the_middle_of_a_real_pause() {
        // Still talking: wait.
        assert_eq!(next_cut(&[sp(200, 2_000)], ms(2_100)), None);
        // A short breath inside a sentence is no pause.
        assert_eq!(
            next_cut(&[sp(200, 2_000), sp(2_300, 4_000)], ms(4_100)),
            None
        );
        // Stopped talking 0.8 s ago: the piece ends 0.3 s after the words.
        assert_eq!(
            next_cut(&[sp(200, 2_000)], ms(2_800)),
            Some((ms(2_300), true))
        );
        // Two sentences, the second still going: cut after the first.
        assert_eq!(
            next_cut(&[sp(0, 3_000), sp(4_000, 6_000)], ms(6_100)),
            Some((ms(3_300), true))
        );
        // Both finished: one cut after the second.
        assert_eq!(
            next_cut(&[sp(0, 3_000), sp(4_000, 6_000)], ms(7_000)),
            Some((ms(6_300), true))
        );
        // The detector's times come in centiseconds.
        assert_eq!(Speech::from_centis(20.0, 200.0), sp(200, 2_000));
    }

    #[test]
    fn silence_is_dropped_but_its_end_is_kept() {
        assert_eq!(next_cut(&[], ms(1_000)), None);
        assert_eq!(
            next_cut(&[], SILENCE_DROP),
            Some((SILENCE_DROP - SILENCE_KEEP, false))
        );
    }

    #[test]
    fn a_long_run_without_a_pause_is_cut_at_its_widest_gap() {
        let talk = [sp(0, 6_000), sp(6_100, 12_000), sp(12_400, 21_000)];
        assert_eq!(next_cut(&talk, ms(19_000)), None, "not long enough yet");
        assert_eq!(next_cut(&talk, ms(21_000)), Some((ms(12_200), true)));
        // No gap at all: everything, but never past whisper's window.
        assert_eq!(
            next_cut(&[sp(0, 21_000)], ms(21_000)),
            Some((ms(21_000), true))
        );
        assert_eq!(
            next_cut(&[sp(0, 40_000)], ms(40_000)),
            Some((MAX_WINDOW, true))
        );
    }

    #[test]
    fn the_window_follows_the_piece_within_its_bounds() {
        // Short pieces get the floor, not their own length.
        assert_eq!(audio_ctx(ms(1_000)), MIN_AUDIO_CTX);
        assert_eq!(audio_ctx(ms(2_500)), MIN_AUDIO_CTX);
        // 14 s: 700 positions plus the margin.
        assert_eq!(audio_ctx(ms(14_000)), 732);
        // Every length gets at least the positions it fills.
        for s in [1usize, 3, 9, 10, 11, 17, 25, 28] {
            let n = ms(s * 1_000);
            let ctx = audio_ctx(n) as usize;
            assert!(ctx >= s * CTX_PER_SECOND, "{s} s: {ctx}");
            assert!(ctx <= MAX_AUDIO_CTX as usize);
        }
        // 30 s and more: the full window.
        assert_eq!(audio_ctx(ms(30_000)), MAX_AUDIO_CTX);
        assert_eq!(audio_ctx(ms(60_000)), MAX_AUDIO_CTX);
    }

    #[test]
    fn a_short_piece_is_padded_to_what_whisper_takes() {
        assert_eq!(pad_short(vec![0.1; 10]).len(), MIN_SAMPLES);
        assert_eq!(pad_short(vec![0.1; ms(5_000)]).len(), ms(5_000));
    }

    #[test]
    fn the_chip_names_whispers_language() {
        assert_eq!(whisper_lang("ru-RU").as_deref(), Some("ru"));
        assert_eq!(whisper_lang("en_US").as_deref(), Some("en"));
        assert_eq!(whisper_lang("zh-Hant-TW").as_deref(), Some("zh"));
        assert_eq!(whisper_lang("haw").as_deref(), Some("haw"));
        for bad in ["", "e", "english", "1a", "ä"] {
            assert_eq!(whisper_lang(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn threads_follow_the_cores_within_bounds() {
        assert_eq!(threads(0), 1);
        assert_eq!(threads(4), 4);
        assert_eq!(threads(64), MAX_THREADS as i32);
    }

    #[test]
    fn whispers_tags_over_silence_are_dropped() {
        assert_eq!(
            clean_piece([" Run the tests.", " Then push."]),
            "Run the tests. Then push."
        );
        assert_eq!(clean_piece([" [BLANK_AUDIO]"]), "");
        assert_eq!(
            clean_piece(["(music)", " Άνοιξε το αρχείο.", "*cough*"]),
            "Άνοιξε το αρχείο."
        );
    }
}
