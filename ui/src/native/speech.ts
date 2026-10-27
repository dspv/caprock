/**
 * Dictation in the iOS app (ADR-083): Apple's speech recognition, on the
 * iPhone itself. The browser's Web Speech API sends Safari's audio to Apple;
 * here on-device recognition is required, so no audio and no text leave the
 * phone — and a language this iPhone cannot recognise on its own is refused
 * with a line that says so, before anything is heard.
 *
 * Same contract as lib/speech.ts's startDictation: `onText` gets everything
 * heard so far, `onEnd` runs once (with an error code when it ended on one),
 * and nothing heard is taken back — a recogniser that ends by itself
 * (Apple's ends after a pause or about a minute) is started again, keeping
 * every word, until stop().
 */
import { SpeechRecognition } from '@capgo/capacitor-speech-recognition'
import type { PluginListenerHandle } from '@capacitor/core'
import { joinDictation, type Dictation } from '@/lib/speech'

/** How many times one dictation starts the recogniser again. */
const MAX_RESTARTS = 40
/** Restarts in a row that heard nothing before it gives up. */
const MAX_EMPTY_RESTARTS = 3
/** Errors after which listening again cannot help. */
const FATAL = new Set(['not-allowed', 'audio-capture', 'on-device-unavailable', 'service-not-allowed'])
/** How long stop() waits for the recogniser's own end before ending anyway. */
const STOP_WAIT_MS = 3000

/** The legacy recogniser, whose on-device mode streams partial results reliably. */
const LEGACY = true

/** Whether this iPhone recognises `lang` on the device itself. */
export async function onDevice(lang: string): Promise<boolean> {
  try {
    const r = await SpeechRecognition.isOnDeviceRecognitionAvailable({ language: lang, preferLegacyRecognizer: LEGACY })
    return r.available
  } catch {
    return false
  }
}

/** Asks for the microphone and speech recognition once; true when both are allowed. */
async function allowed(): Promise<boolean> {
  try {
    const now = await SpeechRecognition.checkPermissions()
    if (now.speechRecognition === 'granted') return true
    const asked = await SpeechRecognition.requestPermissions()
    return asked.speechRecognition === 'granted'
  } catch {
    return false
  }
}

/** The plugin's words for a failure, as the Web Speech API's codes lib/speech.ts explains. */
export function errorCode(message: string): string {
  const m = message.toLowerCase()
  if (m.includes('permission') || m.includes('denied')) return 'not-allowed'
  if (m.includes('locale') || m.includes('on_device') || m.includes('on-device')) return 'on-device-unavailable'
  if (m.includes('unavailable')) return 'service-not-allowed'
  if (m.includes('audio')) return 'audio-capture'
  return 'aborted-native'
}

export function startNativeDictation({ lang, onText, onEnd }: {
  lang: string
  onText: (heard: string) => void
  onEnd: (error?: string) => void
}): Dictation {
  let committed = ''
  let current = ''
  let stopping = false
  let ended = false
  let restarts = 0
  let empty = 0
  let heard = false
  let error: string | undefined
  const handles: PluginListenerHandle[] = []

  const finish = () => {
    if (ended) return
    ended = true
    for (const h of handles) void h.remove().catch(() => {})
    onEnd(error)
  }
  const commit = () => {
    committed = joinDictation(committed, current)
    current = ''
  }
  const run = async (): Promise<void> => {
    try {
      await SpeechRecognition.start({
        language: lang,
        partialResults: true,
        addPunctuation: true,
        useOnDeviceRecognition: true,
        preferLegacyRecognizer: LEGACY,
      })
    } catch (e) {
      error = errorCode(e instanceof Error ? e.message : String(e))
      finish()
    }
  }

  void (async () => {
    if (!(await allowed())) {
      error = 'not-allowed'
      return finish()
    }
    if (!(await onDevice(lang))) {
      error = 'on-device-unavailable'
      return finish()
    }
    if (stopping) return finish()
    handles.push(
      await SpeechRecognition.addListener('partialResults', (e) => {
        if (ended) return
        const t = e.matches?.[0] ?? ''
        // Never wipe words already shown with an empty result.
        if (!t.trim() && current.trim()) return
        current = t
        if (t.trim()) heard = true
        onText(joinDictation(committed, current))
      }),
      await SpeechRecognition.addListener('error', (e) => {
        // Silence and a cancel end a run, not the dictation; the rest are fatal.
        const code = errorCode(`${e.code} ${e.message}`)
        if (FATAL.has(code)) error = code
      }),
      await SpeechRecognition.addListener('listeningState', (e) => {
        if (ended || (e.state ?? e.status) !== 'stopped') return
        empty = heard ? 0 : empty + 1
        if (stopping || error || restarts >= MAX_RESTARTS || empty >= MAX_EMPTY_RESTARTS || document.visibilityState === 'hidden') return finish()
        // Ended by itself after a pause: listen again, keeping every word.
        commit()
        heard = false
        restarts++
        void run()
      }),
    )
    await run()
  })().catch(() => {
    error = 'aborted-native'
    finish()
  })

  return {
    stop() {
      stopping = true
      void SpeechRecognition.stop().catch(() => finish())
      setTimeout(finish, STOP_WAIT_MS)
    },
  }
}
