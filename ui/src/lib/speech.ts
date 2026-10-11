/**
 * Dictation into the chat field, by the browser's own speech recognition
 * (the Web Speech API; `webkitSpeechRecognition` in Safari and Chrome).
 *
 * Caprock records nothing and receives only the text: the browser does the
 * listening, and where it sends the audio is the browser's business — Safari
 * uses Apple's speech service, Chrome Google's. The button says so while it
 * listens (.ai/04-ui.md § Voice input), because rule 4 promises that nothing
 * leaves the machine unless the user turns it on and knows where it goes.
 *
 * Browsers only allow the microphone on a secure page. Caprock on a phone is
 * `http://<Wi-Fi or Tailscale address>`, which is not one, so on the phone the
 * usual answer is the keyboard's own dictation key, and the button says that
 * in one line instead of failing silently.
 */

/** Why voice input is or is not offered here. */
export type SpeechSupport = 'ok' | 'insecure' | 'missing'

/** The slice of SpeechRecognition this file uses. */
interface Recognition {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((e: RecognitionEvent) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}

interface RecognitionEvent {
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>
}

type RecognitionCtor = new () => Recognition

function ctor(): RecognitionCtor | undefined {
  if (typeof window === 'undefined') return undefined
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition
}

/** Whether this page can dictate: needs the API and a secure context. */
export function speechSupport(): SpeechSupport {
  if (!ctor()) return 'missing'
  if (typeof window !== 'undefined' && window.isSecureContext === false) return 'insecure'
  return 'ok'
}

/** What to tell someone whose voice input did not start, in one line. */
export function speechHint(why: SpeechSupport | string): string {
  switch (why) {
    case 'insecure':
      return 'Voice needs an https page and this is http — tap the mic on your keyboard to dictate instead.'
    case 'missing':
      return 'This browser has no voice input — use the dictation key on your keyboard.'
    case 'not-allowed':
    case 'service-not-allowed':
      return 'The microphone was not allowed — allow it for this site, or use the dictation key on your keyboard.'
    case 'no-speech':
      return 'Heard nothing — tap the mic and speak.'
    case 'network':
      return "The browser's speech service could not be reached — use the dictation key on your keyboard."
    case 'audio-capture':
      return 'No microphone found — use the dictation key on your keyboard.'
    default:
      return 'Voice input stopped — try again, or use the dictation key on your keyboard.'
  }
}

/** Joins what was in the field with what was heard, a space between. */
export function joinDictation(before: string, heard: string): string {
  const h = heard.replace(/^\s+/, '')
  if (!h) return before
  if (!before) return h
  return /\s$/.test(before) ? before + h : `${before} ${h}`
}

export interface Dictation {
  stop(): void
}

/**
 * Starts listening. `onText` gets everything heard so far (final words, then
 * the words still being guessed), each time it changes; `onEnd` runs once,
 * with the error code when it ended on one.
 */
export function startDictation({ lang, onText, onEnd }: {
  lang?: string
  onText: (heard: string) => void
  onEnd: (error?: string) => void
}): Dictation | null {
  const C = ctor()
  if (!C) return null
  let rec: Recognition
  try {
    rec = new C()
  } catch {
    return null
  }
  rec.lang = lang || (typeof navigator !== 'undefined' ? navigator.language : '') || 'en-US'
  rec.continuous = true
  rec.interimResults = true
  let error: string | undefined
  let ended = false
  // Rebuilt from every result each time rather than appended from
  // `resultIndex`: Safari has been seen to hand the same final result back
  // in a later event, and appending would say it twice.
  rec.onresult = (e) => {
    let finals = ''
    let interim = ''
    for (let i = 0; i < e.results.length; i++) {
      const r = e.results[i]!
      if (r.isFinal) finals = joinDictation(finals, r[0].transcript)
      else interim = joinDictation(interim, r[0].transcript)
    }
    onText(joinDictation(finals, interim))
  }
  rec.onerror = (e) => {
    // An abort is ours (stop pressed, the view going away), not a fault.
    if (e.error !== 'aborted') error = e.error
  }
  rec.onend = () => {
    if (ended) return
    ended = true
    onEnd(error)
  }
  try {
    rec.start()
  } catch {
    return null
  }
  return {
    stop() {
      try { rec.stop() } catch { /* already stopped */ }
    },
  }
}
