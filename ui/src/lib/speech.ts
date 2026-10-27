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
 *
 * In the iOS app (ADR-083) the same calls use Apple's recognition on the
 * iPhone itself instead (native/speech.ts, loaded only there): on-device is
 * required, so nothing is sent anywhere, and a language the iPhone cannot
 * recognise on its own is refused with its own line.
 */
import { isNativeApp } from '@/native/platform'

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
  if (isNativeApp()) return 'ok'
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
    case 'on-device-unavailable':
      return 'This iPhone cannot recognise that language on its own, so nothing was heard or sent. Pick another language, or add it in iOS Settings → General → Keyboard → Keyboards.'
    default:
      return 'Voice input stopped — try again, or use the dictation key on your keyboard.'
  }
}

/** Where the words are turned into text, for the line shown while it listens. */
export function speechWhere(): string {
  return isNativeApp()
    ? 'Recognised on this iPhone; nothing goes to Apple.'
    : "Your browser's speech service turns it into text."
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

type ResultList = RecognitionEvent['results']

/**
 * What one recognizer has heard: its final words, then the words still being
 * guessed. Rebuilt from every result each time rather than appended from
 * `resultIndex`: Safari has been seen to hand the same final result back in a
 * later event, and appending would say it twice. Chrome on Android has been
 * seen to hand back finals that each repeat the one before ("turn", "turn
 * on", "turn on the"), so a final that starts with everything already heard
 * replaces it rather than adding to it.
 */
export function assembleHeard(results: ResultList): string {
  let finals = ''
  let interim = ''
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!
    const t = r[0]?.transcript ?? ''
    if (!r.isFinal) { interim = joinDictation(interim, t); continue }
    const so = finals.trim().toLowerCase()
    const tt = t.trim().toLowerCase()
    const repeats = so !== '' && tt.startsWith(so) && (tt.length === so.length || /\s/.test(tt[so.length]!))
    finals = repeats ? t.trim() : joinDictation(finals, t)
  }
  return joinDictation(finals, interim)
}

/** Errors after which listening again cannot help: the user or the browser said no. */
const FATAL = new Set(['not-allowed', 'service-not-allowed', 'audio-capture', 'network', 'language-not-supported', 'bad-grammar'])

/** How many times one dictation starts the speech service again. */
const MAX_RESTARTS = 40
/** Restarts in a row that heard nothing before it gives up. */
const MAX_EMPTY_RESTARTS = 3

/**
 * Starts listening. `onText` gets everything heard so far (final words, then
 * the words still being guessed), each time it changes; `onEnd` runs once,
 * with the error code when it ended on one.
 *
 * Nothing heard is ever taken back (.ai/04-ui.md § Voice input, *Never
 * lost*): the speech service ending on its own — Chrome on Android ends a
 * "continuous" session after a pause — starts it again and keeps what was
 * heard; a later event with fewer results, or none, never wipes words
 * already shown; only stop() or a fatal error ends it.
 */
export function startDictation({ lang, onText, onEnd }: {
  lang?: string
  onText: (heard: string) => void
  onEnd: (error?: string) => void
}): Dictation | null {
  if (isNativeApp()) return nativeDictation({ lang, onText, onEnd })
  const C = ctor()
  if (!C) return null
  const tag = lang || (typeof navigator !== 'undefined' ? navigator.language : '') || 'en-US'
  // Words from recognizers that ended, or from a result list that started over.
  let committed = ''
  // What the current recognizer's results say, and the first of them.
  let current = ''
  let first: { final: boolean; text: string } | null = null
  let error: string | undefined
  let ended = false
  let stopping = false
  let restarts = 0
  let empty = 0
  let heardThisRun = false
  let rec: Recognition | null = null

  const commit = () => {
    committed = joinDictation(committed, current)
    current = ''
    first = null
  }
  const finish = () => {
    if (ended) return
    ended = true
    onEnd(error)
  }
  const make = (): Recognition | null => {
    let r: Recognition
    try {
      r = new C()
    } catch {
      return null
    }
    r.lang = tag
    r.continuous = true
    r.interimResults = true
    r.onresult = (e) => {
      if (ended) return
      const res = e.results
      const head = res.length > 0 ? res[0]! : null
      const headText = head?.[0]?.transcript ?? ''
      // A list that started over (Chrome on Android, after a pause): what
      // the old one held is kept, not replaced.
      if (first?.final && head && headText !== first.text) commit()
      const next = assembleHeard(res)
      // An event that says less than nothing — an empty list, a blank
      // final after stop() — never wipes words already shown.
      if (!next.trim() && current.trim()) return
      current = next
      first = head ? { final: head.isFinal, text: headText } : null
      if (next.trim()) heardThisRun = true
      onText(joinDictation(committed, current))
    }
    r.onerror = (e) => {
      // An abort is ours (stop pressed, the view going away), not a fault;
      // silence is not one either — the next start listens again.
      if (e.error !== 'aborted' && e.error !== 'no-speech') error = e.error
    }
    r.onend = () => {
      if (ended || r !== rec) return
      const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
      empty = heardThisRun ? 0 : empty + 1
      if (stopping || hidden || (error && FATAL.has(error)) || restarts >= MAX_RESTARTS || empty >= MAX_EMPTY_RESTARTS) {
        finish()
        return
      }
      // Ended on its own: listen again, keeping every word.
      commit()
      error = undefined
      heardThisRun = false
      restarts++
      const again = make()
      rec = again
      if (!again) { finish(); return }
      try {
        again.start()
      } catch {
        finish()
      }
    }
    return r
  }

  rec = make()
  if (!rec) return null
  try {
    rec.start()
  } catch {
    return null
  }
  return {
    stop() {
      stopping = true
      try { rec?.stop() } catch { finish() }
    },
  }
}

/**
 * The iOS app's dictation (native/speech.ts), behind a dynamic import so the
 * web page and the desktop never load the plugin. A stop() that comes before
 * the import has finished is carried over.
 */
function nativeDictation({ lang, onText, onEnd }: { lang?: string; onText: (heard: string) => void; onEnd: (error?: string) => void }): Dictation {
  let inner: Dictation | null = null
  let stopped = false
  const tag = lang || (typeof navigator !== 'undefined' ? navigator.language : '') || 'en-US'
  import('@/native/speech').then(
    (m) => {
      inner = m.startNativeDictation({ lang: tag, onText, onEnd })
      if (stopped) inner.stop()
    },
    () => onEnd('service-not-allowed'),
  )
  return {
    stop() {
      stopped = true
      inner?.stop()
    },
  }
}
