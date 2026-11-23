/**
 * The microphone in the desktop app's message fields (ADR-102): the chat's
 * field (TerminalKeys) and the composer under a terminal (Composer). Hold to
 * talk — press and hold, speak, release, and the words are in the field, not
 * sent — or click to start and click again to stop. The words appear in the
 * field as they are heard, after what was typed. A chip beside it says the
 * language (lib/speechlang.ts, the phone's chips) and changes it.
 *
 * Apple's speech recognition on this Mac does the listening, through the
 * shell (lib/deskvoice.ts); nothing is recorded or sent anywhere. Shown only
 * where the shell says it can: the Mac app. Windows, Linux and a browser tab
 * never show it.
 */
import { useEffect, useReducer, useRef, useState } from 'react'
import { deskVoice, onDictation, useDeskVoiceAvailable } from '@/lib/deskvoice'
import { releaseStops, VOICE_IDLE, voiceActive, voiceFieldText, voiceMessage, voiceReducer, type VoiceState } from '@/lib/dictation'
import { COMMON_SPEECH_LANGS, baseLang, langChip, langName, myLangs, nextSpeechLang, setSpeechLang, speechLang } from '@/lib/speechlang'

/** How long a release waits for the recogniser's last words before it ends anyway. */
const FINISH_WAIT_MS = 3000

export interface DeskVoice {
  /** The shell can dictate here: show the button. */
  available: boolean
  state: VoiceState
  /** The field is being written by the microphone: keep the keyboard off it. */
  busy: boolean
  lang: string
  pickLang: (tag: string) => void
  /** Pointer down on the mic. */
  press: () => void
  /** Pointer up (or cancelled) after press. */
  release: () => void
  /** A keyboard press of the mic: start, or stop. */
  toggle: () => void
  /** Sent while it listened: stop and drop what comes after. */
  cancel: () => void
  /** The field is the user's again (they typed): forget the last result's line. */
  dismiss: () => void
  /** Whether the current dictation is hold-to-talk (vs started by a click). */
  holding: boolean
}

/**
 * One field's dictation. `getText` reads the field as it is now; `setText`
 * writes it while the words come in.
 */
export function useDeskVoice({ enabled, getText, setText }: {
  enabled: boolean
  getText: () => string
  setText: (t: string) => void
}): DeskVoice {
  const available = useDeskVoiceAvailable(enabled)
  const [state, dispatch] = useReducer(voiceReducer, VOICE_IDLE)
  const now = useRef(state)
  now.current = state
  const [lang, setLang] = useState(speechLang)
  const [holding, setHolding] = useState(false)
  // The press under way: when it went down, and whether it started listening.
  const pressed = useRef<{ at: number; started: boolean } | null>(null)
  // A stop asked for before the shell named the dictation.
  const stopEarly = useRef(false)
  const finishTimer = useRef(0)
  const setTextRef = useRef(setText)
  setTextRef.current = setText

  useEffect(() => {
    if (!available) return
    return onDictation((e) => {
      if (e.kind === 'asking') dispatch({ type: 'asking', id: e.id })
      else if (e.kind === 'listening') dispatch({ type: 'live', id: e.id })
      else if (e.kind === 'partial') dispatch({ type: 'partial', id: e.id, text: e.text })
      else if (e.kind === 'final') dispatch({ type: 'final', id: e.id, text: e.text })
      else dispatch({ type: 'end', id: e.id, ...(e.error ? { error: e.error } : {}) })
    })
  }, [available])

  // The field follows what is heard, live, and keeps it once done.
  useEffect(() => {
    const t = voiceFieldText(state)
    if (t !== null && state.phase !== 'starting') setTextRef.current(t)
    if (!voiceActive(state)) window.clearTimeout(finishTimer.current)
  }, [state])

  // The view going away ends the listening; its words are already in the field.
  useEffect(() => () => {
    window.clearTimeout(finishTimer.current)
    const s = now.current
    if (voiceActive(s) && s.id !== null) void deskVoice.stop(s.id, true)
  }, [])

  const start = () => {
    if (voiceActive(now.current)) return
    const tag = speechLang()
    setLang(tag)
    stopEarly.current = false
    dispatch({ type: 'start', before: getText(), lang: tag })
    deskVoice.start(tag).then(
      (id) => {
        dispatch({ type: 'started', id })
        if (stopEarly.current) stopNative(id)
      },
      () => dispatch({ type: 'refused', error: 'unsupported' }),
    )
  }
  const stopNative = (id: number) => {
    void deskVoice.stop(id)
    // The recogniser normally ends within a second; if it does not, what
    // was heard is kept and the microphone let go.
    window.clearTimeout(finishTimer.current)
    finishTimer.current = window.setTimeout(() => {
      if (now.current.id !== id || !voiceActive(now.current)) return
      void deskVoice.stop(id, true)
      dispatch({ type: 'end', id })
    }, FINISH_WAIT_MS)
  }
  const stop = () => {
    const s = now.current
    if (!voiceActive(s) || s.phase === 'stopping' || s.phase === 'final') return
    dispatch({ type: 'stop' })
    if (s.id === null) stopEarly.current = true
    else stopNative(s.id)
  }

  return {
    available,
    state,
    busy: voiceActive(state),
    lang,
    holding,
    pickLang: (tag) => {
      setSpeechLang(tag)
      setLang(speechLang())
    },
    press: () => {
      const active = voiceActive(now.current)
      pressed.current = { at: Date.now(), started: !active }
      if (!active) {
        setHolding(true)
        start()
      }
    },
    release: () => {
      const p = pressed.current
      pressed.current = null
      if (!p) return
      if (releaseStops(p.at, Date.now(), p.started, now.current.asking)) stop()
      // A click, or a release while macOS asked: it listens until the next click.
      else setHolding(false)
    },
    toggle: () => {
      if (voiceActive(now.current)) stop()
      else {
        setHolding(false)
        start()
      }
    },
    cancel: () => {
      const s = now.current
      if (!voiceActive(s)) {
        if (s.phase !== 'idle') dispatch({ type: 'dismiss' })
        return
      }
      if (s.id !== null) void deskVoice.stop(s.id, true)
      else stopEarly.current = true
      dispatch({ type: 'cancel' })
    },
    dismiss: () => dispatch({ type: 'dismiss' }),
  }
}

/** The line under the field: what the microphone is doing, or why it stopped. */
export function deskVoiceLine(v: DeskVoice): { tone: 'live' | 'muted' | 'danger'; text: string } | null {
  const s = v.state
  const name = langName(s.lang || v.lang)
  switch (s.phase) {
    case 'starting':
      return { tone: 'muted', text: 'Starting the microphone…' }
    case 'listening':
    case 'partial':
      if (s.asking) return { tone: 'muted', text: 'Waiting for macOS to allow the microphone and speech recognition for Caprock…' }
      return {
        tone: 'live',
        text: `Listening in ${name} — ${v.holding ? 'release to stop' : 'click the mic to stop'}. Recognised on this Mac; nothing is sent.`,
      }
    case 'stopping':
    case 'final':
      return { tone: 'muted', text: 'Finishing…' }
    case 'inserted':
      return s.error ? { tone: 'muted', text: voiceMessage(s.error, name) } : null
    case 'error':
      return { tone: 'danger', text: voiceMessage(s.error ?? 'failed', name) }
    case 'idle':
      return null
  }
}

/**
 * The language chip and the microphone, side by side. `compact` is the
 * composer's 24px row; otherwise the chat field's 44px buttons.
 */
export function DeskMic({ v, compact = false }: { v: DeskVoice; compact?: boolean }) {
  const [menu, setMenu] = useState(false)
  if (!v.available) return null
  const active = v.busy
  const tapLang = () => {
    const next = nextSpeechLang(v.lang, myLangs())
    if (next === 'more') setMenu((m) => !m)
    else v.pickLang(next)
  }
  const chipCls = compact
    ? 'mb-[5px] h-[24px] min-w-[26px] rounded-[6px] px-1 text-[11px]'
    : 'h-12 w-11 rounded-sm border text-[13px]'
  const micCls = compact
    ? `mb-[5px] h-[24px] w-[26px] rounded-[6px] ${active ? 'bg-danger/15 text-danger' : 'text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg'}`
    : `h-12 w-14 rounded-sm border ${active ? 'border-danger bg-danger/15 text-danger' : 'border-border-strong bg-panel-2 text-fg hover:border-accent'}`
  return (
    <>
      <span className="relative shrink-0">
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={tapLang}
          disabled={active}
          aria-haspopup="menu"
          aria-expanded={menu}
          aria-label={`Voice input language: ${langName(v.lang)}. Click to change`}
          title={`Voice input listens for ${langName(v.lang)}`}
          data-testid="desk-voice-lang"
          className={`flex items-center justify-center font-medium disabled:opacity-50 ${chipCls} ${menu ? 'border-accent text-accent' : compact ? 'text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg' : 'border-border-strong bg-panel-2 text-fg-muted hover:border-accent'}`}
        >
          {langChip(v.lang)}
        </button>
        {menu && <DeskLangMenu current={v.lang} onPick={(t) => { v.pickLang(t); setMenu(false) }} onClose={() => setMenu(false)} />}
      </span>
      <button
        type="button"
        data-testid="desk-mic"
        data-phase={v.state.phase}
        aria-pressed={active}
        aria-label={active ? 'Stop voice input' : 'Voice input: hold to talk, or click to start'}
        title={active ? 'Stop: the words stay in the field' : `Hold to talk — release and the words are in the field, not sent. Or click to start and click again to stop. ${langName(v.lang)}, recognised on this Mac.`}
        onPointerDown={(e) => {
          if (e.button !== 0) return
          // The field keeps the focus; the release is ours wherever it lands.
          e.preventDefault()
          try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* not capturable: the button's own up still comes */ }
          v.press()
        }}
        onPointerUp={() => v.release()}
        onPointerCancel={() => v.release()}
        // Enter or Space on the focused button: a click with no pointer.
        onClick={(e) => { if (e.detail === 0) v.toggle() }}
        className={`flex shrink-0 select-none items-center justify-center ${micCls}`}
      >
        <MicGlyph size={compact ? 14 : 22} />
      </button>
    </>
  )
}

/** The status line under (or over) the field. */
export function DeskVoiceLine({ v, className = '' }: { v: DeskVoice; className?: string }) {
  const line = v.available ? deskVoiceLine(v) : null
  if (!line) return null
  return (
    <div role="status" aria-live="polite" data-desk-voice-line={line.tone}
      className={`text-[12px] leading-snug ${line.tone === 'danger' ? 'text-danger' : line.tone === 'live' ? 'text-fg' : 'text-fg-muted'} ${className}`}>
      {line.tone === 'live' && <span className="text-danger">● </span>}
      {line.text}
    </div>
  )
}

/** This viewer's languages, then the common ones; opens upwards. */
function DeskLangMenu({ current, onPick, onClose }: { current: string; onPick: (tag: string) => void; onClose: () => void }) {
  const mine = myLangs()
  const more = COMMON_SPEECH_LANGS.filter(([t]) => !mine.some((m) => baseLang(m) === baseLang(t)))
  const row = (tag: string, name: string) => {
    const on = baseLang(tag) === baseLang(current)
    return (
      <button key={tag} type="button" role="menuitemradio" aria-checked={on}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onPick(tag)}
        className={`flex min-h-8 w-full items-center gap-3 px-3 text-left text-[13px] hover:bg-panel-2 ${on ? 'font-medium text-accent' : 'text-fg'}`}>
        <span className="w-7 shrink-0 text-[11px] text-fg-faint">{langChip(tag)}</span>
        {name}
      </button>
    )
  }
  return (
    <>
      <div className="fixed inset-0 z-40" aria-hidden onClick={onClose} />
      <div role="menu" aria-label="Voice input language" className="absolute bottom-full right-0 z-50 mb-2 max-h-[50vh] w-52 overflow-y-auto rounded-md border border-border-strong bg-panel py-1 shadow-lg">
        {mine.map((t) => row(t, langName(t)))}
        {more.length > 0 && <div className="border-t border-border px-3 pb-1 pt-2 text-[11px] uppercase tracking-wide text-fg-faint">More</div>}
        {more.map(([t, name]) => row(t, name))}
      </div>
    </>
  )
}

function MicGlyph({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
    </svg>
  )
}
