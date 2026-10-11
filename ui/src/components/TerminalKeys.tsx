import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { TermState } from '@/lib/termv2'
import { useSavedPromptsFor } from '@/lib/saved'
import { ChatPickerList, useChatPicker } from './ChatPicker'
import { joinDictation, speechHint, speechSupport, startDictation, type Dictation } from '@/lib/speech'

/** A newline inside the prompt: ESC CR, what a terminal sends for Alt+Enter
 *  (see Terminal.tsx — a bare line feed submits once text is typed). */
const NEWLINE = '\x1b\r'

/** How long to wait between the text and the Enter that submits it. Sent in
 *  one write, a TUI reads the pair as a paste and keeps the Enter as a line. */
const SUBMIT_DELAY_MS = 80

/** The field's tallest: five 22px lines, its 10px padding and border. */
const FIELD_MAX_PX = 5 * 22 + 20 + 2

const KEYS: [label: string, bytes: string, title: string][] = [
  ['Esc', '\x1b', 'Escape — close a menu, interrupt Claude Code'],
  ['Tab', '\t', 'Tab — complete, switch mode'],
  ['↑', '\x1b[A', 'Up — previous prompt, move in a menu'],
  ['↓', '\x1b[B', 'Down — move in a menu'],
  ['⏎', '\r', 'Enter — choose in a menu, submit'],
  ['Ctrl+C', '\x03', 'Ctrl+C — interrupt'],
]

/** A message sent from the field while the terminal was not live (WP-13). */
interface Held {
  id: number
  text: string
  /** Set once it was not sent on reconnect: why, and it waits for Send now. */
  draft?: string
}

/** A message ending in an @file mention, with a space after it (see deliver). */
export function endMention(message: string): string {
  return /(^|\s)@\S+$/.test(message) ? `${message} ` : message
}

/** How long a "not sent" notice for a raw key stays up. */
const NOTICE_MS = 4000

function heldKey(sessionId: string): string {
  return `caprock.keys.held.${sessionId}`
}

/** Held messages survive the page being reloaded (a phone discards a tab in the background). */
function loadHeld(sessionId?: string): Held[] {
  if (!sessionId) return []
  try {
    const raw = sessionStorage.getItem(heldKey(sessionId))
    const list: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(list) ? (list as Held[]).filter((h) => typeof h?.text === 'string') : []
  } catch {
    return []
  }
}

function saveHeld(sessionId: string | undefined, held: readonly Held[]): void {
  if (!sessionId) return
  try {
    if (held.length === 0) sessionStorage.removeItem(heldKey(sessionId))
    else sessionStorage.setItem(heldKey(sessionId), JSON.stringify(held))
  } catch { /* storage refused: the list still shows until the page goes */ }
}

/**
 * Typing into a session from a phone.
 *
 * A phone's keyboard has no Esc, Tab, arrows or Ctrl, and Claude Code's menus
 * — the permission prompt above all — are answered with exactly those. So the
 * keys are buttons, and the text goes in a field big enough to read what is
 * being sent before sending it, rather than letter by letter into a canvas.
 */
export function TerminalKeys({ send, attach, initial = '', state, isPromptWaiting, sessionId, chips = false, submitText, pickers = false, voice = false, foldKeys = false }: {
  send: (bytes: string) => void
  /** Attaches photos; the paths it returns, if any, go into the field (the chat). */
  attach?: (files: File[]) => Promise<void | readonly string[]>
  initial?: string
  /** The terminal's connection; absent, it is taken as live. */
  state?: TermState
  /** Whether a permission prompt waits right now, asked before a held message is sent. */
  isPromptWaiting?: () => Promise<boolean>
  /** Keys the held messages kept across a reload. */
  sessionId?: string
  /** Show the saved prompts for this session as chips above the field (ADR-051). */
  chips?: boolean
  /** Sends a message instead of typing it here: the chat's queue (ADR-053).
   *  False when it was not sent; the text goes back into an empty field. */
  submitText?: (text: string) => Promise<boolean>
  /** The `/` and `@` pickers over the field (ADR-053); needs sessionId. */
  pickers?: boolean
  /** A microphone button that dictates into the field (lib/speech). */
  voice?: boolean
  /** The six raw keys behind a Keys button: the phone's chat, where a message
   *  is the common case and Esc or an arrow the rare one. */
  foldKeys?: boolean
}) {
  const [text, setText] = useState(initial)
  const [keysOpen, setKeysOpen] = useState(!foldKeys)
  // Dictation (lib/speech): what was in the field when it started, so what is
  // heard is shown after it, live, and the person reads it before Send.
  const [listening, setListening] = useState(false)
  const [voiceNote, setVoiceNote] = useState('')
  const dictation = useRef<Dictation | null>(null)
  const beforeVoice = useRef('')
  useEffect(() => () => dictation.current?.stop(), [])
  const toggleVoice = () => {
    if (dictation.current) {
      dictation.current.stop()
      return
    }
    const why = speechSupport()
    if (why !== 'ok') {
      setVoiceNote(speechHint(why))
      return
    }
    beforeVoice.current = text
    const d = startDictation({
      onText: (heard) => setText(joinDictation(beforeVoice.current, heard)),
      onEnd: (err) => {
        dictation.current = null
        setListening(false)
        setVoiceNote(err ? speechHint(err) : '')
      },
    })
    if (!d) {
      setVoiceNote(speechHint('missing'))
      return
    }
    dictation.current = d
    setListening(true)
    setVoiceNote('')
  }
  const live = state === undefined || state === 'live'
  // The offline queue (.ai/21-app.md § Phone v2): a message sent while the
  // terminal is not live is held and shown as "will send"; on reconnect it is
  // sent only if the session is still live and no permission prompt waits,
  // otherwise it stays as a draft with Send now. Raw keys are never queued:
  // an Esc or an Enter landing a minute late answers a different question.
  const [held, setHeld] = useState<Held[]>(() => loadHeld(sessionId))
  const heldRef = useRef(held)
  heldRef.current = held
  const [notice, setNotice] = useState('')
  useEffect(() => { saveHeld(sessionId, held) }, [sessionId, held])
  useEffect(() => {
    if (!notice) return
    const id = window.setTimeout(() => setNotice(''), NOTICE_MS)
    return () => window.clearTimeout(id)
  }, [notice])
  // Why a message cannot wait for a reconnect: none is coming.
  const finalReason = state === 'ended' ? 'the session ended' : state === 'revoked' ? 'this device can no longer type' : ''
  useEffect(() => {
    const toDraft = (reason: string) => setHeld((list) => list.map((h) => (h.draft ? h : { ...h, draft: reason })))
    if (!heldRef.current.some((h) => !h.draft)) return
    if (finalReason) { toDraft(finalReason); return }
    if (!live) return
    let current = true
    void (async () => {
      let prompt: boolean
      try {
        prompt = isPromptWaiting ? await isPromptWaiting() : false
      } catch {
        prompt = true // could not tell: never guess into a prompt
      }
      if (!current) return // dropped again meanwhile: still held, retried on the next reconnect
      if (prompt) { toDraft('a permission prompt is waiting'); return }
      for (const h of heldRef.current.filter((m) => !m.draft)) {
        setHeld((list) => list.filter((m) => m.id !== h.id))
        await deliver(h.text)
      }
    })()
    return () => { current = false }
    // Only a change of connection starts a flush; the list is read through its ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, live])
  const [attaching, setAttaching] = useState(false)
  const field = useRef<HTMLTextAreaElement>(null)
  // One line idle, growing with what is typed up to MAX_LINES, then scrolling:
  // a fixed two-line box hid most of a pre-filled "In <file> around line N: ".
  useLayoutEffect(() => {
    const el = field.current
    if (!el) return
    el.style.height = 'auto'
    // Hidden (the bar is display:none on a wide window) it measures 0; leave
    // it at its one-row height rather than pin it to nothing.
    if (el.scrollHeight === 0) return
    el.style.height = `${Math.min(el.scrollHeight + 2, FIELD_MAX_PX)}px`
  }, [text])
  // Arriving with a started message means the next thing is to finish it.
  useEffect(() => {
    const el = field.current
    if (!initial || !el) return
    el.focus()
    el.setSelectionRange(initial.length, initial.length)
  }, [initial])
  const picker = useRef<HTMLInputElement>(null)

  // The `/` and `@` pickers. A pick sets the text; the caret goes after
  // what was inserted once the field has it.
  const caretAfter = useRef<number | null>(null)
  const chooser = useChatPicker(sessionId, pickers, (t, caret) => {
    caretAfter.current = caret
    setText(t)
  })
  useLayoutEffect(() => {
    const el = field.current
    const at = caretAfter.current
    if (!el || at === null) return
    caretAfter.current = null
    el.focus()
    el.setSelectionRange(at, at)
  }, [text])
  const trackCaret = (el: HTMLTextAreaElement) => chooser.track(el.value, el.selectionStart ?? el.value.length)
  const listId = `chat-picker-${sessionId ?? 'field'}`

  // The picked photos' paths are typed into the session, as a drop's are;
  // what to say about them goes in the field and is sent after. Where attach
  // returns the paths instead (the chat), they go into the field, quoted.
  const onPicked = async (files: File[]) => {
    if (!attach || files.length === 0) return
    setAttaching(true)
    try {
      const paths = await attach(files)
      if (paths && paths.length > 0) {
        const quoted = paths.map((p) => `"${p}" `).join('')
        setText((t) => (t && !/\s$/.test(t) ? `${t} ${quoted}` : `${t}${quoted}`))
        field.current?.focus()
      }
    } finally {
      setAttaching(false)
      if (picker.current) picker.current.value = ''
    }
  }

  // The text, then Enter on its own after a pause. A message ending in an
  // @file mention gets a space first: Claude Code's file menu is open after
  // it, and Enter would pick from the menu rather than send.
  const deliver = (message: string): Promise<void> => {
    if (submitText) {
      return submitText(message).then((ok) => {
        if (!ok) setText((t) => (t ? t : message))
      })
    }
    return new Promise<void>((resolve) => {
      send(endMention(message).replace(/\r?\n/g, NEWLINE))
      window.setTimeout(() => { send('\r'); resolve() }, SUBMIT_DELAY_MS)
    })
  }

  const sendKey = (bytes: string, label: string) => {
    if (live) { send(bytes); return }
    setNotice(`Not connected — ${label} was not sent. Keys are never queued.`)
  }

  const submit = () => {
    dictation.current?.stop()
    setVoiceNote('')
    if (text && !live) {
      // Sent after the end: a draft at once, never "will send".
      setHeld((list) => [...list, { id: Date.now() + Math.random(), text, ...(finalReason ? { draft: finalReason } : {}) }])
    } else if (text) {
      void deliver(text)
    } else {
      sendKey('\r', 'Enter')
    }
    setText('')
    chooser.track('', 0)
    field.current?.focus()
  }

  // Back into the field, to change or drop.
  const edit = (h: Held) => {
    setHeld((list) => list.filter((m) => m.id !== h.id))
    setText((t) => (t ? `${t}\n${h.text}` : h.text))
    field.current?.focus()
  }

  const sendNow = (h: Held) => {
    setHeld((list) => list.filter((m) => m.id !== h.id))
    void deliver(h.text)
  }

  return (
    <div className="grid gap-2 border-t border-border px-2 py-2">
      {(held.length > 0 || notice) && (
        <ul aria-live="polite" aria-label="Messages waiting" className="grid gap-1.5">
          {notice && <li className="rounded-sm border border-warn/50 bg-warn/10 px-2.5 py-1.5 text-[13px] text-fg">{notice}</li>}
          {held.map((h) => (
            <li key={h.id} className="flex min-w-0 items-center gap-2 rounded-sm border border-border-strong bg-panel-2 px-2.5 py-1.5 text-[13px]">
              <span className="min-w-0 flex-1">
                <span className={h.draft ? 'text-warn' : 'text-fg-muted'}>{h.draft ? `Not sent — ${h.draft}` : 'Will send when connected'}</span>
                <span className="block truncate mono text-fg">{h.text}</span>
              </span>
              {h.draft && (
                <button
                  type="button"
                  disabled={!live}
                  onClick={() => sendNow(h)}
                  className="shrink-0 rounded-sm bg-accent px-3 py-2 min-h-[44px] text-[13px] font-medium text-bg hover:brightness-110 disabled:opacity-50"
                >
                  Send now
                </button>
              )}
              <button
                type="button"
                onClick={() => edit(h)}
                aria-label={`Edit the message: ${h.text}`}
                className="shrink-0 rounded-sm border border-border-strong px-3 py-2 min-h-[44px] text-[13px] text-fg hover:border-accent"
              >
                Edit
              </button>
            </li>
          ))}
        </ul>
      )}
      {chips && sessionId && (
        <SavedChips
          sessionId={sessionId}
          onPick={(t) => {
            // Into the field, not sent: one more tap on Send, with a chance
            // to add a file name or take a word out first.
            setText((cur) => (cur.trim() ? `${cur.replace(/\s+$/, '')}\n${t}` : t))
          }}
        />
      )}
      {/* The field on a row of its own, full width: beside Photo and Send it
        * was a third of a 320px screen. */}
      <div className="relative grid gap-2">
        {/* 16px: iOS zooms the page into any field set smaller, and the
          * terminal above would be cut off when it did. Inline, because
          * .input's own 12px outranked the text-[16px] utility; the padding
          * likewise, and it makes one line a 44px target. */}
        {pickers && <ChatPickerList p={chooser} listId={listId} />}
        <textarea
          ref={field}
          value={text}
          onChange={(e) => { setText(e.target.value); trackCaret(e.target) }}
          onSelect={(e) => trackCaret(e.currentTarget)}
          onKeyDown={(e) => {
            if (chooser.onKeyDown(e)) return
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          rows={1}
          placeholder={pickers ? 'Type · / commands · @ files' : 'Type to the session…'}
          aria-label="Type to the session"
          {...(pickers ? {
            'aria-autocomplete': 'list' as const,
            'aria-expanded': chooser.open,
            'aria-controls': listId,
            'aria-activedescendant': chooser.open && chooser.rows.length > 0 ? `${listId}-${chooser.active}` : undefined,
          } : {})}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="input w-full min-w-0 resize-none overflow-y-auto leading-snug"
          style={{ fontSize: 16, lineHeight: '22px', paddingTop: 10, paddingBottom: 10, maxHeight: FIELD_MAX_PX }}
        />
        {(listening || voiceNote) && (
          <div role="status" aria-live="polite" className={`text-[13px] leading-snug ${listening ? 'text-fg' : 'text-fg-muted'}`}>
            {listening
              ? <><span className="text-danger">●</span> Listening — tap the mic again to stop, then Send. Your browser&apos;s speech service turns it into text.</>
              : voiceNote}
          </div>
        )}
        <div className="flex items-center justify-end gap-2">
        {foldKeys && (
          <button
            type="button"
            aria-expanded={keysOpen}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setKeysOpen((v) => !v)}
            title="Esc, Tab, arrows, Enter and Ctrl+C, for the agent's menus"
            className={`mr-auto shrink-0 rounded-sm border px-3 py-2 min-h-[44px] text-[14px] hover:border-accent ${keysOpen ? 'border-accent text-fg' : 'border-border-strong text-fg-muted'}`}
          >
            Keys
          </button>
        )}
        {attach && (
          <>
            {/* No `capture`: with it iOS opens only the camera; without it the
              * picker offers Take Photo and the photo library both. */}
            <input
              ref={picker}
              type="file"
              accept="image/*"
              multiple
              hidden
              aria-hidden="true"
              tabIndex={-1}
              data-testid="photo-picker"
              onChange={(e) => void onPicked([...(e.target.files ?? [])])}
            />
            <button
              type="button"
              disabled={attaching}
              onClick={() => picker.current?.click()}
              title="Attach a photo from the camera or the library"
              aria-label="Attach a photo"
              className="shrink-0 rounded-sm border border-border-strong bg-panel-2 px-3 py-2 min-h-[44px] text-[14px] text-fg hover:border-accent disabled:opacity-50"
            >
              {attaching ? 'Adding…' : 'Photo'}
            </button>
          </>
        )}
        {voice && (
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={toggleVoice}
            aria-pressed={listening}
            aria-label={listening ? 'Stop dictating' : 'Dictate'}
            title={listening ? 'Stop dictating' : 'Dictate: speak, read it in the field, then Send'}
            className={`flex h-12 w-14 shrink-0 items-center justify-center rounded-sm border ${listening ? 'border-danger bg-danger/15 text-danger' : 'border-border-strong bg-panel-2 text-fg hover:border-accent'}`}
          >
            <MicIcon />
          </button>
        )}
        <button
          type="button"
          onClick={submit}
          className="shrink-0 rounded-sm bg-accent px-4 py-2 min-h-[44px] text-[14px] font-medium text-bg hover:brightness-110"
        >
          Send
        </button>
        </div>
      </div>
      {/* Two rows of three below `sm`: in one row of six, "Ctrl+C" filled its
        * button edge to edge even at 390px. */}
      {keysOpen && <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5">
        {KEYS.map(([label, bytes, title]) => (
          <button
            key={label}
            type="button"
            title={title}
            aria-label={title}
            // Keep the field focused, so the keyboard does not drop and rise
            // between a key and the next word.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => sendKey(bytes, label)}
            className="min-h-[44px] min-w-0 rounded-sm border border-border-strong bg-panel-2 px-1 text-[13px] mono text-fg hover:border-accent active:bg-accent/15"
          >
            {label}
          </button>
        ))}
      </div>}
    </div>
  )
}

function MicIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
    </svg>
  )
}

/**
 * The saved prompts for a session — every project's and its own project's —
 * as a row of chips above the field (ADR-051). A tap puts the prompt in the
 * field; Send sends it. Nothing when there are none: the row is not an
 * advertisement for the feature.
 */
function SavedChips({ sessionId, onPick }: { sessionId: string; onPick: (text: string) => void }) {
  const items = useSavedPromptsFor(sessionId)
  if (items.length === 0) return null
  return (
    <div role="group" aria-label="Saved prompts" className="-mx-2 flex gap-1.5 overflow-x-auto px-2 pb-0.5 [scrollbar-width:none]">
      {items.map((v) => (
        <button
          key={v.id}
          type="button"
          title={v.text}
          // Keep the field's focus (and a phone's keyboard) where it was.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(v.text)}
          className="min-h-[36px] max-w-[220px] shrink-0 truncate rounded-full border border-border-strong bg-panel-2 px-3 text-[13px] text-fg hover:border-accent active:bg-accent/15"
        >
          {v.name}
        </button>
      ))}
    </div>
  )
}
