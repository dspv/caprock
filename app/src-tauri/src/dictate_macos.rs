//! Dictation on macOS (`dictate.rs` says what the page sees): the microphone
//! through AVAudioEngine into Apple's speech recogniser, with
//! `requiresOnDeviceRecognition` set, so the audio is recognised on this Mac
//! and never sent to Apple. A language with no on-device model here is
//! refused before anything is heard (`on-device-unavailable`); there is no
//! fallback to the server.
//!
//! A request Apple ends by itself while the user still listens (a pause, or
//! its time limit) is replaced by a new one on the same microphone, and what
//! it heard is kept in front of what the next one hears: only the user's
//! release, click, Enter or Esc ends a dictation (`should_restart`).
//!
//! Everything that touches a session runs on the main thread (the
//! recogniser's queue is the main queue, and every command hops there), so
//! the one running session lives in a thread-local. The permission answers
//! come back on other threads and hop back the same way.

use crate::dictate::{apple_error, join_heard, should_restart, Event, Sink, Status};
use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::Bool;
use objc2::AllocAnyThread;
use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeAudio};
use objc2_avf_audio::{AVAudioEngine, AVAudioPCMBuffer, AVAudioTime};
use objc2_foundation::{NSBundle, NSError, NSLocale, NSOperationQueue, NSString};
use objc2_speech::{
    SFSpeechAudioBufferRecognitionRequest, SFSpeechRecognitionResult, SFSpeechRecognitionTask,
    SFSpeechRecognizer, SFSpeechRecognizerAuthorizationStatus,
};
use std::cell::RefCell;
use std::ptr::NonNull;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Runtime};

/// The dictation asked for last; 0 once it was stopped. A start still
/// waiting on a permission answer checks it before it listens, so a
/// dictation stopped while macOS asked does not start listening afterwards.
static WANTED: AtomicU64 = AtomicU64::new(0);

/// Frames per buffer the microphone hands over: about 20 ms at 48 kHz.
const TAP_FRAMES: u32 = 1024;

struct Session {
    id: u64,
    sink: Sink,
    engine: Retained<AVAudioEngine>,
    recognizer: Retained<SFSpeechRecognizer>,
    request: Retained<SFSpeechAudioBufferRecognitionRequest>,
    task: Retained<SFSpeechRecognitionTask>,
    /// Which request is current: answers from a replaced one are ignored.
    run: u32,
    /// What earlier requests of this dictation heard.
    committed: String,
    /// What the current request has heard so far.
    current: String,
    heard_this_run: bool,
    /// The user asked to stop: the next end is the end.
    stopping: bool,
    restarts: u32,
    /// Requests in a row that heard nothing.
    empty: u32,
}

impl Session {
    /// The microphone off, and the recogniser told no more audio is coming.
    fn hush(&self) {
        unsafe {
            if self.engine.isRunning() {
                self.engine.stop();
            }
            self.engine.inputNode().removeTapOnBus(0);
            self.request.endAudio();
        }
    }

    fn all_heard(&self) -> String {
        join_heard(&self.committed, &self.current)
    }
}

thread_local! {
    static ACTIVE: RefCell<Option<Session>> = const { RefCell::new(None) };
}

/// Running from an app bundle, whose Info.plist names why it asks: outside
/// one (`cargo run`, a test binary) asking for speech recognition ends the
/// process, so it is not offered there.
fn bundled() -> bool {
    let bundle = NSBundle::mainBundle();
    bundle.bundleIdentifier().is_some() && bundle.bundlePath().to_string().ends_with(".app")
}

pub fn status() -> Status {
    if bundled() {
        Status {
            supported: true,
            reason: None,
            engine: Some("apple"),
        }
    } else {
        Status {
            supported: false,
            reason: Some("unbundled"),
            engine: Some("apple"),
        }
    }
}

pub fn start<R: Runtime>(app: AppHandle<R>, id: u64, locale: String, sink: Sink) {
    WANTED.store(id, Ordering::SeqCst);
    let a = app.clone();
    let _ = app.run_on_main_thread(move || {
        // One at a time: the one running ends here.
        end_active(Some("superseded"), true);
        if !bundled() {
            sink(Event::End {
                id,
                error: Some("unsupported"),
            });
            return;
        }
        authorize_speech(a, id, locale, sink);
    });
}

pub fn stop<R: Runtime>(app: &AppHandle<R>, id: u64, cancel: bool) {
    let _ = WANTED.compare_exchange(id, 0, Ordering::SeqCst, Ordering::SeqCst);
    let _ = app.run_on_main_thread(move || {
        let mine = ACTIVE.with_borrow(|a| a.as_ref().is_some_and(|s| s.id == id));
        if !mine {
            return; // already over, or still asking (WANTED ends that one)
        }
        if cancel {
            end_active(None, true);
        } else {
            // The final words follow from the recogniser, then the end.
            ACTIVE.with_borrow_mut(|a| {
                if let Some(s) = a.as_mut() {
                    s.stopping = true;
                    s.hush();
                }
            });
        }
    });
}

/// Ends the running session, if any: says so to its page with `error`.
fn end_active(error: Option<&'static str>, cancel: bool) {
    let Some(s) = ACTIVE.take() else {
        return;
    };
    s.hush();
    if cancel {
        unsafe { s.task.cancel() };
    }
    (s.sink)(Event::End { id: s.id, error });
}

fn authorize_speech<R: Runtime>(app: AppHandle<R>, id: u64, locale: String, sink: Sink) {
    match unsafe { SFSpeechRecognizer::authorizationStatus() } {
        SFSpeechRecognizerAuthorizationStatus::Authorized => authorize_mic(app, id, locale, sink),
        SFSpeechRecognizerAuthorizationStatus::NotDetermined => {
            // The page keeps it on through a release while macOS asks.
            sink(Event::Asking { id });
            let done = RcBlock::new(move |s: SFSpeechRecognizerAuthorizationStatus| {
                if s != SFSpeechRecognizerAuthorizationStatus::Authorized {
                    sink(Event::End {
                        id,
                        error: Some("speech-denied"),
                    });
                    return;
                }
                let (a, l, k) = (app.clone(), locale.clone(), sink.clone());
                let _ = app.run_on_main_thread(move || authorize_mic(a, id, l, k));
            });
            // macOS asks once, naming Caprock and NSSpeechRecognitionUsageDescription.
            unsafe { SFSpeechRecognizer::requestAuthorization(&done) };
        }
        _ => sink(Event::End {
            id,
            error: Some("speech-denied"),
        }),
    }
}

fn authorize_mic<R: Runtime>(app: AppHandle<R>, id: u64, locale: String, sink: Sink) {
    let Some(audio) = (unsafe { AVMediaTypeAudio }) else {
        sink(Event::End {
            id,
            error: Some("no-microphone"),
        });
        return;
    };
    match unsafe { AVCaptureDevice::authorizationStatusForMediaType(audio) } {
        AVAuthorizationStatus::Authorized => begin(id, &locale, sink),
        AVAuthorizationStatus::NotDetermined => {
            sink(Event::Asking { id });
            let done = RcBlock::new(move |granted: Bool| {
                if !granted.as_bool() {
                    sink(Event::End {
                        id,
                        error: Some("mic-denied"),
                    });
                    return;
                }
                let (l, k) = (locale.clone(), sink.clone());
                let _ = app.run_on_main_thread(move || begin(id, &l, k));
            });
            // macOS asks once, naming Caprock and NSMicrophoneUsageDescription.
            unsafe { AVCaptureDevice::requestAccessForMediaType_completionHandler(audio, &done) };
        }
        _ => sink(Event::End {
            id,
            error: Some("mic-denied"),
        }),
    }
}

/// A fresh on-device request fed from the microphone, and its task; the
/// engine's tap is (re)installed to feed this request.
fn listen(
    id: u64,
    run: u32,
    engine: &AVAudioEngine,
    recognizer: &SFSpeechRecognizer,
) -> (
    Retained<SFSpeechAudioBufferRecognitionRequest>,
    Retained<SFSpeechRecognitionTask>,
) {
    let request = unsafe { SFSpeechAudioBufferRecognitionRequest::new() };
    unsafe {
        request.setShouldReportPartialResults(true);
        request.setRequiresOnDeviceRecognition(true);
        request.setAddsPunctuation(true);
    }
    let input = unsafe { engine.inputNode() };
    let format = unsafe { input.outputFormatForBus(0) };
    let feed = request.clone();
    let tap = RcBlock::new(
        move |buffer: NonNull<AVAudioPCMBuffer>, _when: NonNull<AVAudioTime>| {
            // SAFETY: the engine hands a valid buffer for the call's length.
            unsafe { feed.appendAudioPCMBuffer(buffer.as_ref()) };
        },
    );
    unsafe {
        input.removeTapOnBus(0);
        input.installTapOnBus_bufferSize_format_block(
            0,
            TAP_FRAMES,
            Some(&format),
            RcBlock::as_ptr(&tap),
        );
    }
    let handler = RcBlock::new(
        move |result: *mut SFSpeechRecognitionResult, error: *mut NSError| {
            heard(id, run, result, error);
        },
    );
    let task = unsafe { recognizer.recognitionTaskWithRequest_resultHandler(&request, &handler) };
    (request, task)
}

/// Listens: on the main thread, with both permissions granted.
fn begin(id: u64, locale: &str, sink: Sink) {
    let end = |error: &'static str| {
        sink(Event::End {
            id,
            error: Some(error),
        })
    };
    if WANTED.load(Ordering::SeqCst) != id {
        // Stopped, or another started, while macOS asked.
        sink(Event::End { id, error: None });
        return;
    }
    let ns_locale =
        NSLocale::initWithLocaleIdentifier(NSLocale::alloc(), &NSString::from_str(locale));
    let Some(recognizer) =
        (unsafe { SFSpeechRecognizer::initWithLocale(SFSpeechRecognizer::alloc(), &ns_locale) })
    else {
        return end("language-unsupported");
    };
    // The rule-4 line: only a language this Mac recognises by itself.
    if !unsafe { recognizer.supportsOnDeviceRecognition() } {
        return end("on-device-unavailable");
    }
    if !unsafe { recognizer.isAvailable() } {
        return end("unavailable");
    }
    unsafe { recognizer.setQueue(&NSOperationQueue::mainQueue()) };

    let engine = unsafe { AVAudioEngine::new() };
    let input = unsafe { engine.inputNode() };
    let format = unsafe { input.outputFormatForBus(0) };
    if unsafe { format.channelCount() } == 0 || unsafe { format.sampleRate() } <= 0.0 {
        return end("no-microphone");
    }
    let (request, task) = listen(id, 0, &engine, &recognizer);
    unsafe { engine.prepare() };
    if unsafe { engine.startAndReturnError() }.is_err() {
        unsafe {
            task.cancel();
            input.removeTapOnBus(0);
        }
        return end("no-microphone");
    }
    ACTIVE.set(Some(Session {
        id,
        sink: sink.clone(),
        engine,
        recognizer,
        request,
        task,
        run: 0,
        committed: String::new(),
        current: String::new(),
        heard_this_run: false,
        stopping: false,
        restarts: 0,
        empty: 0,
    }));
    sink(Event::Listening { id });
}

/// What to do with one answer from the recogniser.
enum Step {
    Say(Sink, Event),
    Restart,
    Finish(Option<(Sink, Event)>, Option<&'static str>),
}

/// The recogniser's answer, on the main queue: words so far, the final
/// words, or why it stopped.
fn heard(id: u64, run: u32, result: *mut SFSpeechRecognitionResult, error: *mut NSError) {
    let step = ACTIVE.with_borrow_mut(|a| {
        let s = a.as_mut().filter(|s| s.id == id && s.run == run)?;
        // SAFETY: nil or a valid result for the duration of the call.
        let code = if let Some(r) = unsafe { result.as_ref() } {
            let text = unsafe { r.bestTranscription().formattedString() }.to_string();
            if !text.trim().is_empty() {
                s.current = text;
                s.heard_this_run = true;
            }
            if !unsafe { r.isFinal() } {
                let text = s.all_heard();
                return Some(Step::Say(s.sink.clone(), Event::Partial { id, text }));
            }
            None
        } else {
            // SAFETY: nil or a valid NSError.
            let e = unsafe { error.as_ref() }?;
            apple_error(&e.domain().to_string(), e.code())
        };
        let empty = if s.heard_this_run { 0 } else { s.empty + 1 };
        if should_restart(s.stopping, code, s.restarts, empty) {
            s.committed = s.all_heard();
            s.current.clear();
            s.heard_this_run = false;
            s.empty = empty;
            s.restarts += 1;
            return Some(Step::Restart);
        }
        let text = s.all_heard();
        let fin = (!text.trim().is_empty()).then(|| (s.sink.clone(), Event::Final { id, text }));
        Some(Step::Finish(fin, code))
    });
    match step {
        None => {}
        Some(Step::Say(sink, e)) => sink(e),
        Some(Step::Restart) => restart(id),
        Some(Step::Finish(fin, code)) => {
            if let Some((sink, e)) = fin {
                sink(e);
            }
            end_active(code, false);
        }
    }
}

/// Apple ended the request by itself while the user listens: a new one on
/// the same microphone, what was heard kept in front.
fn restart(id: u64) {
    ACTIVE.with_borrow_mut(|a| {
        let Some(s) = a.as_mut().filter(|s| s.id == id) else {
            return;
        };
        unsafe { s.request.endAudio() };
        s.run += 1;
        let (request, task) = listen(id, s.run, &s.engine, &s.recognizer);
        s.request = request;
        s.task = task;
    });
}
