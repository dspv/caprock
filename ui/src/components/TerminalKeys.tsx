import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { TermState } from '@/lib/termv2'

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
export function TerminalKeys({ send, attach, initial = '', state, isPromptWaiting, sessionId }: {
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
}) {
  const [text, setText] = useState(initial)
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

  // The text, then Enter on its own after a pause.
  const deliver = (message: string) => new Promise<void>((resolve) => {
    send(message.replace(/\r?\n/g, NEWLINE))
    window.setTimeout(() => { send('\r'); resolve() }, SUBMIT_DELAY_MS)
  })

  const sendKey = (bytes: string, label: string) => {
    if (live) { send(bytes); return }
    setNotice(`Not connected — ${label} was not sent. Keys are never queued.`)
  }

  const submit = () => {
    if (text && !live) {
      // Sent after the end: a draft at once, never "will send".
      setHeld((list) => [...list, { id: Date.now() + Math.random(), text, ...(finalReason ? { draft: finalReason } : {}) }])
    } else if (text) {
      void deliver(text)
    } else {
      sendKey('\r', 'Enter')
    }
    setText('')
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
      {/* The field on a row of its own, full width: beside Photo and Send it
        * was a third of a 320px screen. */}
      <div className="grid gap-2">
        {/* 16px: iOS zooms the page into any field set smaller, and the
          * terminal above would be cut off when it did. Inline, because
          * .input's own 12px outranked the text-[16px] utility; the padding
          * likewise, and it makes one line a 44px target. */}
        <textarea
          ref={field}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          rows={1}
          placeholder="Type to the session…"
          aria-label="Type to the session"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="input w-full min-w-0 resize-none overflow-y-auto leading-snug"
          style={{ fontSize: 16, lineHeight: '22px', paddingTop: 10, paddingBottom: 10, maxHeight: FIELD_MAX_PX }}
        />
        <div className="flex items-center justify-end gap-2">
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
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5">
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
      </div>
    </div>
  )
}
