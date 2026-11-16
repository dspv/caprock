/**
 * Hold to talk (.ai/04-ui.md § Jarvis, *Hold to talk*): held — the mic
 * button, or ⌥Space (Ctrl+Shift+Space off macOS, TALK_KEY) — it listens and
 * shows what it hears in the field; released, what was heard is sent; Esc
 * cancels and puts the field back as it was.
 *
 * The listening is lib/speech.ts's: the browser's speech service (Safari's
 * goes to Apple, Chrome's to Google), or, in the iOS app, Apple's recognition
 * on the iPhone itself. The line shown while it listens says which (rule 4).
 */
import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import { isMacPlatform, isTauri } from './appmode'
import { talkKey, talkKeyUp } from './appkeys'
import { ScreenShown } from './refresh'
import { joinDictation, speechHint, speechSupport, startDictation, type Dictation } from './speech'
import { speechLang } from './speechlang'
import { isNativeApp } from '@/native/platform'

/**
 * Whether the mic is offered here. In the desktop app on macOS the web view
 * is WebKit's, which has `webkitSpeechRecognition` (checked 2026-11-16) and
 * asks macOS for the microphone and speech recognition on first use. Off
 * macOS the app's web views have no working speech service — WebView2's
 * needs Google keys a shell does not carry, WebKitGTK has none — so the
 * button is not drawn there rather than drawn broken. A browser without the
 * API gets no button either; an http page (a phone on Wi-Fi) gets one that
 * says, in one line, to use the keyboard's dictation key.
 */
export function micOffered(): boolean {
  if (isNativeApp()) return true
  if (isTauri() && !isMacPlatform()) return false
  return speechSupport() !== 'missing'
}

/** How long a release waits for the speech service's last words before sending what it has. */
export const RELEASE_WAIT_MS = 2500

export interface HoldToTalk {
  listening: boolean
  /** A one-line note after a failed or empty listen; '' none. */
  note: string
  /** Press: start listening, the field's text kept before what is heard. */
  start: () => void
  /** Release: stop, and send what was heard. */
  release: () => void
  /** Esc: stop, send nothing, put the field back. */
  cancel: () => void
}

export function useHoldToTalk({ enabled, line, setLine, send }: {
  /** Off: the key does nothing and the button is not drawn. */
  enabled: boolean
  line: string
  setLine: (v: string) => void
  /** Called once with the final text after a release; nothing when nothing was heard. */
  send: (text: string) => void
}): HoldToTalk {
  const shown = useContext(ScreenShown)
  const [listening, setListening] = useState(false)
  const [note, setNote] = useState('')
  const dictation = useRef<Dictation | null>(null)
  const before = useRef('')
  const heard = useRef('')
  // What ending does: 'send' after a release, 'cancel' after Esc.
  const ending = useRef<'' | 'send' | 'cancel'>('')
  const lineRef = useRef(line)
  lineRef.current = line
  const sendRef = useRef(send)
  sendRef.current = send
  const setLineRef = useRef(setLine)
  setLineRef.current = setLine
  const fallback = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const finish = useCallback((error?: string) => {
    if (fallback.current) { clearTimeout(fallback.current); fallback.current = undefined }
    if (!dictation.current) return
    dictation.current = null
    setListening(false)
    const how = ending.current
    ending.current = ''
    if (how === 'cancel') { setLineRef.current(before.current); return }
    const text = joinDictation(before.current, heard.current).trim()
    if (error && !heard.current.trim()) { setNote(speechHint(error)); return }
    if (how === 'send') {
      if (!heard.current.trim()) { setNote(speechHint('no-speech').replace('tap the mic', 'hold the mic')); return }
      sendRef.current(text)
    }
  }, [])

  const start = useCallback(() => {
    if (!enabled || dictation.current) return
    const why = speechSupport()
    if (why !== 'ok') { setNote(speechHint(why)); return }
    setNote('')
    before.current = lineRef.current
    heard.current = ''
    ending.current = ''
    const d = startDictation({
      lang: speechLang(),
      onText: (h) => { heard.current = h; setLineRef.current(joinDictation(before.current, h)) },
      onEnd: (error) => finish(error),
    })
    if (!d) { setNote(speechHint('missing')); return }
    dictation.current = d
    setListening(true)
  }, [enabled, finish])

  const stopWith = useCallback((how: 'send' | 'cancel') => {
    const d = dictation.current
    // Once ending, the first word stands: Esc and then letting go of the
    // mic must not turn the cancel into a send.
    if (!d || ending.current) return
    ending.current = how
    try { d.stop() } catch { /* ended already */ }
    // The service's end can lag, or never come: send what is there.
    fallback.current = setTimeout(() => finish(), how === 'cancel' ? 0 : RELEASE_WAIT_MS)
  }, [finish])

  const release = useCallback(() => stopWith('send'), [stopWith])
  const cancel = useCallback(() => stopWith('cancel'), [stopWith])

  // The key, only while the screen is in front. On window, in the capture
  // phase: the page's other Escape handlers must not swallow a cancel, or
  // the release that follows would send what was meant to be dropped.
  useEffect(() => {
    if (!enabled || !shown) return
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dictation.current) { e.preventDefault(); e.stopPropagation(); cancel(); return }
      if (!talkKey(e)) return
      // Held, the key repeats: it would type a no-break space each time.
      e.preventDefault()
      if (e.repeat || dictation.current) return
      const modal = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')].some((d) => !d.closest('[hidden]'))
      if (modal) return
      start()
    }
    const up = (e: KeyboardEvent) => {
      if (dictation.current && ending.current === '' && talkKeyUp(e)) { e.preventDefault(); release() }
    }
    window.addEventListener('keydown', down, true)
    window.addEventListener('keyup', up, true)
    return () => {
      window.removeEventListener('keydown', down, true)
      window.removeEventListener('keyup', up, true)
    }
  }, [enabled, shown, start, release, cancel])

  // Leaving the screen, or the page going away, ends it without sending.
  useEffect(() => { if (!shown && dictation.current) cancel() }, [shown, cancel])
  useEffect(() => () => {
    if (fallback.current) clearTimeout(fallback.current)
    try { dictation.current?.stop() } catch { /* */ }
    dictation.current = null
  }, [])

  return { listening, note, start, release, cancel }
}
