/**
 * Voice input in the desktop app's chat (ADR-102): the state of one
 * dictation, as a pure reducer, and what the microphone button does on a
 * press and a release. The native side is `lib/deskvoice.ts`; the button and
 * the line under the field are `components/DeskVoice.tsx`.
 *
 * The path: idle → starting (asked the shell) → listening (the microphone is
 * on) → partial (words heard, shown in the field after what was typed) →
 * stopping (released; the recogniser finishes) → final → inserted (the words
 * stay in the field, not sent). Every error ends it with a line that says
 * why: a refused microphone or speech recognition, a language this Mac
 * cannot recognise on its own (nothing is sent to Apple instead), or
 * nothing heard. Words already heard are never taken back.
 *
 * The first time, macOS asks for the microphone and speech recognition
 * (`asking`). A release while it asks does not end the dictation: once
 * allowed, it listens as if clicked on, until the next click. A request
 * Apple ends by itself mid-dictation is replaced by the shell, which keeps
 * what was heard in front (app/src-tauri/src/dictate.rs `should_restart`):
 * here that is only more partial words.
 */
import { joinDictation } from './speech'

export type VoicePhase = 'idle' | 'starting' | 'listening' | 'partial' | 'stopping' | 'final' | 'inserted' | 'error'

/** Why a dictation ended badly, as the line under the field explains it. */
export type VoiceError =
  | 'denied-mic'
  | 'denied-speech'
  | 'unavailable-language'
  | 'no-audio'
  | 'no-microphone'
  | 'unsupported'
  | 'failed'

export interface VoiceState {
  phase: VoicePhase
  /** The shell's id for this dictation, once it answered. */
  id: number | null
  /** What was in the field when it started; the words go after it. */
  before: string
  /** Everything heard so far. */
  heard: string
  /** The language it listens for (BCP-47). */
  lang: string
  /** macOS is asking for permission: a release keeps it on. */
  asking?: boolean
  error?: VoiceError
}

export type VoiceAction =
  | { type: 'start'; before: string; lang: string }
  | { type: 'started'; id: number }
  /** macOS shows its permission prompt for this dictation. */
  | { type: 'asking'; id: number }
  /** The microphone is on. */
  | { type: 'live'; id: number }
  | { type: 'partial'; id: number; text: string }
  | { type: 'final'; id: number; text: string }
  | { type: 'stop' }
  | { type: 'end'; id: number; error?: string }
  /** The shell refused to start at all (no such command, a bad language). */
  | { type: 'refused'; error?: string }
  /** Sent while it listened: what was heard went with the message. */
  | { type: 'cancel' }
  | { type: 'dismiss' }

export const VOICE_IDLE: VoiceState = { phase: 'idle', id: null, before: '', heard: '', lang: '' }

/** Whether the microphone is on or about to be. */
export function voiceActive(s: VoiceState): boolean {
  return s.phase === 'starting' || s.phase === 'listening' || s.phase === 'partial' || s.phase === 'stopping' || s.phase === 'final'
}

/** The shell's code for why it ended, as one of ours; null when it is no fault. */
export function voiceError(code: string | undefined): VoiceError | null {
  switch (code) {
    case undefined:
    case '':
    case 'superseded':
      return null
    case 'mic-denied':
      return 'denied-mic'
    case 'speech-denied':
      return 'denied-speech'
    case 'on-device-unavailable':
    case 'language-unsupported':
    case 'unavailable':
      return 'unavailable-language'
    case 'no-speech':
      return 'no-audio'
    case 'no-microphone':
      return 'no-microphone'
    case 'unsupported':
    case 'unbundled':
      return 'unsupported'
    default:
      return 'failed'
  }
}

export function voiceReducer(s: VoiceState, a: VoiceAction): VoiceState {
  switch (a.type) {
    case 'start':
      if (voiceActive(s)) return s
      return { phase: 'starting', id: null, before: a.before, heard: '', lang: a.lang }
    case 'started':
      // Released before the shell answered: still stopping, now with an id.
      if (s.phase === 'starting') return { ...s, id: a.id, phase: 'listening' }
      if (s.phase === 'stopping' && s.id === null) return { ...s, id: a.id }
      return s
    case 'asking':
      if (a.id !== s.id || !voiceActive(s) || s.phase === 'final') return s
      return { ...s, asking: true }
    case 'live': {
      if (a.id !== s.id || !voiceActive(s)) return s
      const { asking: _was, ...rest } = s
      return rest
    }
    case 'partial': {
      if (a.id !== s.id || !voiceActive(s) || s.phase === 'final') return s
      // An empty guess never wipes words already shown.
      const heard = a.text.trim() || !s.heard.trim() ? a.text : s.heard
      return { ...s, heard, phase: s.phase === 'stopping' ? 'stopping' : heard.trim() ? 'partial' : 'listening' }
    }
    case 'final':
      if (a.id !== s.id || !voiceActive(s)) return s
      return { ...s, heard: a.text.trim() ? a.text : s.heard, phase: 'final' }
    case 'stop':
      if (s.phase === 'starting' || s.phase === 'listening' || s.phase === 'partial') return { ...s, phase: 'stopping' }
      return s
    case 'end': {
      if (a.id !== s.id || !voiceActive(s)) return s
      const err = voiceError(a.error)
      if (s.heard.trim()) {
        // The words stay whatever ended it; silence after them is no fault.
        const { error: _old, ...rest } = s
        return err && err !== 'no-audio' ? { ...rest, phase: 'inserted', error: err } : { ...rest, phase: 'inserted' }
      }
      if (a.error === 'superseded') return { ...VOICE_IDLE, lang: s.lang }
      // Stopped by the user while macOS still asked: nothing to say.
      if (s.asking && !err) return { ...VOICE_IDLE, lang: s.lang }
      return { ...s, phase: 'error', error: err ?? 'no-audio' }
    }
    case 'refused':
      if (s.phase !== 'starting' && !(s.phase === 'stopping' && s.id === null)) return s
      return { ...s, phase: 'error', error: voiceError(a.error) ?? 'failed' }
    case 'cancel':
      return { ...VOICE_IDLE, lang: s.lang }
    case 'dismiss':
      if (voiceActive(s)) return s
      return { ...VOICE_IDLE, lang: s.lang }
  }
}

/**
 * What the field shows while it listens and once it is done: what was typed,
 * then what was heard. `null` when the field is the user's own (idle, or an
 * error with nothing heard).
 */
export function voiceFieldText(s: VoiceState): string | null {
  if (s.phase === 'idle' || s.phase === 'error') return null
  return joinDictation(s.before, s.heard)
}

/** How long a press must last to count as hold-to-talk rather than a click. */
export const HOLD_MS = 350

/**
 * Whether a release stops listening. A press that started it and lasted
 * HOLD_MS or more is hold-to-talk: the release ends it. A shorter one was a
 * click, which leaves it listening until the next click. A press while it
 * already listened is that next click: its release ends it. A release of
 * the press that started it while macOS asks for permission never ends it:
 * once allowed, it listens until the next click.
 */
export function releaseStops(downAt: number, upAt: number, startedByThisPress: boolean, asking = false): boolean {
  if (startedByThisPress && asking) return false
  return !startedByThisPress || upAt - downAt >= HOLD_MS
}

/** The line under the field for an error, naming the language where it matters. */
export function voiceMessage(e: VoiceError, language: string): string {
  switch (e) {
    case 'denied-mic':
      return 'Caprock may not use the microphone. Allow it in System Settings → Privacy & Security → Microphone, then try again.'
    case 'denied-speech':
      return 'Caprock may not use speech recognition. Allow it in System Settings → Privacy & Security → Speech Recognition, then try again.'
    case 'unavailable-language':
      return `${language} isn't available on this Mac without sending audio to Apple, so nothing was recorded. Pick another language, or add ${language} under System Settings → Keyboard → Dictation.`
    case 'no-audio':
      return 'Heard nothing — hold the mic and speak.'
    case 'no-microphone':
      return 'No microphone found — connect one and try again.'
    case 'unsupported':
      return 'Voice input needs the Caprock app on a Mac.'
    case 'failed':
      return 'Voice input stopped — try again.'
  }
}
