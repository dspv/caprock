import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { INPUT_HIGHLIGHT_KEY, keys } from '@/lib/appkeys'
import type { TermState } from '@/lib/termv2'
import { useSavedPromptsFor } from '@/lib/saved'
import { ChatPickerList, useChatPicker } from './ChatPicker'
import { joinDictation, speechHint, speechSupport, startDictation, type Dictation } from '@/lib/speech'
import { COMMON_SPEECH_LANGS, langChip, langIntroDue, langName, markLangIntroSeen, myLangs, nextSpeechLang, setSpeechLang, speechLang } from '@/lib/speechlang'

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
  /** Photos attached to it: saved files' paths, pasted in before the text. */
  paths?: string[]
  /** Set once it was not sent on reconnect: why, and it waits for Send now. */
  draft?: string
  /** It failed on its way (the daemon or the relay did not take it): its
   *  button says Retry rather than Send now. */
  failed?: boolean
  /** On its way to the daemon and not yet confirmed: kept in storage so a
   *  tab discarded mid-send still has it (as a draft) when it comes back. */
  inflight?: boolean
}

/** Why a message found on its way after a reload is a draft: it may have arrived. */
export const MAYBE_SENT = 'it may not have arrived — check the chat before you retry'

/** A message ending in an @file mention, with a space after it (see deliver). */
export function endMention(message: string): string {
  return /(^|\s)@\S+$/.test(message) ? `${message} ` : message
}

/** How long a send waits for the speech service's last words after stop(). */
const END_WAIT_MS = 3000

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
    return Array.isArray(list)
      ? (list as Held[]).filter((h) => typeof h?.text === 'string').map((h) => {
        const m = Array.isArray(h.paths) ? { ...h, paths: h.paths.filter((p) => typeof p === 'string') } : { ...h }
        // Left on its way when the page went: never sent twice by itself.
        if (m.inflight) { delete m.inflight; m.draft = MAYBE_SENT; m.failed = true }
        return m
      })
      : []
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

function draftKey(sessionId: string): string {
  return `caprock.keys.draft.${sessionId}`
}

/** What was in the field, dictated or typed, when the page went: a phone
 *  discards a background tab, and a dictated message must not go with it. */
function loadDraft(sessionId?: string): string {
  if (!sessionId) return ''
  try {
    return sessionStorage.getItem(draftKey(sessionId)) ?? ''
  } catch {
    return ''
  }
}

function saveDraft(sessionId: string | undefined, text: string): void {
  if (!sessionId) return
  try {
    if (text) sessionStorage.setItem(draftKey(sessionId), text)
    else sessionStorage.removeItem(draftKey(sessionId))
  } catch { /* storage refused: the field still holds it while the page lives */ }
}

/**
 * Typing into a session from a phone.
 *
 * A phone's keyboard has no Esc, Tab, arrows or Ctrl, and Claude Code's menus
 * — the permission prompt above all — are answered with exactly those. So the
 * keys are buttons, and the text goes in a field big enough to read what is
 * being sent before sending it, rather than letter by letter into a canvas.
 */
/** A photo attached in the field: the saved file's path, sent as a paste
 *  (never shown), and a preview while the picked file is at hand. */
export interface Attached {
  path: string
  /** An object URL of the picked file; absent for one restored from a draft. */
  url?: string
}

/** A message as it is held or shown: the words, with "Image N" for each photo. */
export function heldLabel(h: { text: string; paths?: readonly string[] }): string {
  const n = h.paths?.length ?? 0
  if (n === 0) return h.text
  const imgs = Array.from({ length: n }, (_, i) => `[Image ${i + 1}]`).join(' ')
  return h.text ? `${imgs} ${h.text}` : imgs
}

export function TerminalKeys({ send, attach, sendPaths, initial = '', state, isPromptWaiting, sessionId, chips = false, submitText, pickers = false, voice = false, foldKeys = false, placeholder }: {
  send: (bytes: string) => void
  /** Attaches photos. Where it returns the saved paths (the chat; one per
   *  file, '' for one that failed), each shows as an "Image N" chip over the
   *  field and goes to sendPaths before the words on Send. */
  attach?: (files: File[]) => Promise<void | readonly string[]>
  /** Pastes the attached photos into the session as the desktop terminal
   *  pastes a dropped image, so Claude Code shows `[Image #N]`. */
  sendPaths?: (paths: readonly string[]) => Promise<void>
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
  /** The field's hint, in place of the terminal's *Type · / commands · @ files*. */
  placeholder?: string
}) {
  // A started message, else what was in the field when the page went.
  const [text, setText] = useState(() => initial || loadDraft(sessionId))
  useEffect(() => { saveDraft(sessionId, text) }, [sessionId, text])
  // The photos attached in the field: chips, never their paths in the text.
  const [attached, setAttached] = useState<Attached[]>([])
  const attachedNow = useRef(attached)
  attachedNow.current = attached
  useEffect(() => () => { for (const a of attachedNow.current) if (a.url) URL.revokeObjectURL(a.url) }, [])
  const dropAttached = (i: number) => setAttached((list) => {
    const a = list[i]
    if (a?.url) URL.revokeObjectURL(a.url)
    return list.filter((_, j) => j !== i)
  })
  /** Empties the chips, letting their previews go; returns the paths. */
  const takeAttached = (): string[] => {
    const list = attachedNow.current
    for (const a of list) if (a.url) URL.revokeObjectURL(a.url)
    attachedNow.current = []
    setAttached([])
    return list.map((a) => a.path)
  }
  // What the field holds now, for a send that runs after the render that
  // set it (the microphone's release, when the last words arrive late).
  const textNow = useRef(text)
  textNow.current = text
  const [keysOpen, setKeysOpen] = useState(!foldKeys)
  // Dictation (lib/speech): what was in the field when it started, so what is
  // heard is shown after it, live, and the person reads it before Send.
  const [listening, setListening] = useState(false)
  const [voiceNote, setVoiceNote] = useState('')
  const dictation = useRef<Dictation | null>(null)
  // The language it listens for (lib/speechlang): the speech service cannot
  // tell, so the chip beside the mic says it and a tap changes it.
  const [lang, setLang] = useState(speechLang)
  const [langMenu, setLangMenu] = useState(false)
  const [langIntro, setLangIntro] = useState(() => voice && langIntroDue())
  const pickLang = (tag: string) => {
    setSpeechLang(tag)
    setLang(speechLang())
    setLangMenu(false)
  }
  const tapLang = () => {
    if (langIntro) {
      markLangIntroSeen()
      setLangIntro(false)
    }
    const next = nextSpeechLang(lang, myLangs())
    if (next === 'more') setLangMenu((v) => !v)
    else pickLang(next)
  }
  const beforeVoice = useRef('')
  useEffect(() => () => dictation.current?.stop(), [])
  const toggleVoice = () => {
    if (dictation.current) {
      stopAsked.current = true
      dictation.current.stop()
      return
    }
    const why = speechSupport()
    if (why !== 'ok') {
      setVoiceNote(speechHint(why))
      return
    }
    if (langIntro) {
      markLangIntroSeen()
      setLangIntro(false)
    }
    startRec()
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
  // Messages on their way to the daemon, not yet confirmed (see deliver).
  const inflight = useRef<Held[]>([])
  const persistHeld = () => saveHeld(sessionId, [...heldRef.current, ...inflight.current])
  useEffect(() => { saveHeld(sessionId, [...held, ...inflight.current]) }, [sessionId, held])
  /** A message the daemon did not take: a draft with Retry, never dropped. */
  const holdFailed = (message: string, paths: readonly string[], why: string) => {
    const h: Held = { id: Date.now() + Math.random(), text: message, ...(paths.length ? { paths: [...paths] } : {}), draft: why, failed: true }
    heldRef.current = [...heldRef.current, h]
    setHeld((list) => [...list, h])
    persistHeld()
  }
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
        await deliver(h.text, h.paths)
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
  // returns the paths instead (the chat), each becomes an "Image N" chip over
  // the field — never the path in the text, which on a phone was a line of
  // "/Users/…/Application Support/caprock/paste/…" (owner, 2026-10-18).
  const onPicked = async (files: File[]) => {
    if (!attach || files.length === 0) return
    setAttaching(true)
    try {
      const paths = await attach(files)
      if (paths && paths.length > 0) {
        const aligned = paths.length === files.length
        const next: Attached[] = []
        paths.forEach((p, i) => {
          if (!p) return
          const f = aligned ? files[i] : undefined
          next.push({ path: p, ...(f && typeof URL.createObjectURL === 'function' ? { url: URL.createObjectURL(f) } : {}) })
        })
        setAttached((list) => [...list, ...next])
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
  //
  // Attached photos go first, each pasted on its own (sendPaths), so Claude
  // Code shows `[Image #1]` `[Image #2]` and the words follow — what the
  // desktop terminal does with a dropped image. Where nothing can paste them,
  // their quoted paths lead the text, as before.
  //
  // Until the daemon says it has the message, it is kept in storage as on
  // its way; if the daemon does not take it, it becomes a draft with Retry
  // (.ai/04-ui.md § Voice input, *Never lost*). Nothing is put back into a
  // field that holds something else, where it would be dropped.
  const deliver = async (message: string, paths?: readonly string[]): Promise<boolean> => {
    const imgs = paths?.filter(Boolean) ?? []
    const entry: Held = { id: Date.now() + Math.random(), text: message, ...(imgs.length ? { paths: imgs } : {}), inflight: true }
    inflight.current = [...inflight.current, entry]
    persistHeld()
    try {
      return await deliverNow(message, imgs)
    } finally {
      inflight.current = inflight.current.filter((h) => h.id !== entry.id)
      persistHeld()
    }
  }
  const deliverNow = async (message: string, imgs: readonly string[]): Promise<boolean> => {
    if (imgs.length > 0 && !sendPaths) {
      message = `${imgs.map((p) => `"${p}" `).join('')}${message}`
    } else if (imgs.length > 0 && sendPaths) {
      try {
        await sendPaths(imgs)
      } catch {
        holdFailed(message, imgs, 'the photos did not reach Caprock')
        return false
      }
      if (!message) {
        // Photos alone: Enter, as after a drop in the terminal.
        await new Promise<void>((resolve) => window.setTimeout(() => { send('\r'); resolve() }, SUBMIT_DELAY_MS))
        return true
      }
    }
    if (submitText) {
      let ok = false
      try {
        ok = await submitText(message)
      } catch {
        ok = false
      }
      // The photos went in already: only the words wait for Retry.
      if (!ok) holdFailed(message, [], 'Caprock did not confirm it')
      return ok
    }
    return new Promise<boolean>((resolve) => {
      send(endMention(message).replace(/\r?\n/g, NEWLINE))
      window.setTimeout(() => { send('\r'); resolve(true) }, SUBMIT_DELAY_MS)
    })
  }

  const sendKey = (bytes: string, label: string) => {
    if (live) { send(bytes); return }
    setNotice(`Not connected — ${label} was not sent. Keys are never queued.`)
  }

  const submit = (said?: string) => {
    if (said === undefined && dictation.current) {
      // Send while it listens: the last words come after stop(), so it is
      // sent when the speech service ends (or after END_WAIT_MS), with them.
      sendOnEnd.current = true
      stopAsked.current = true
      window.clearTimeout(endTimer.current)
      endTimer.current = window.setTimeout(finishSend, END_WAIT_MS)
      dictation.current.stop()
      return
    }
    const text = said ?? textNow.current
    if (dictation.current) {
      // Sent on the timer while the service is still finishing: what it
      // still hands back is checked against what went (see startRec).
      sentAs.current = text
      stopAsked.current = true
      dictation.current.stop()
    }
    setVoiceNote('')
    const paths = takeAttached()
    const some = text || paths.length > 0
    if (some && !live) {
      // Sent after the end: a draft at once, never "will send".
      setHeld((list) => [...list, { id: Date.now() + Math.random(), text, ...(paths.length ? { paths } : {}), ...(finalReason ? { draft: finalReason } : {}) }])
    } else if (some) {
      void deliver(text, paths)
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
    const paths = h.paths ?? []
    if (paths.length) setAttached((list) => [...list, ...paths.map((path) => ({ path }))])
    field.current?.focus()
  }

  const sendNow = (h: Held) => {
    setHeld((list) => list.filter((m) => m.id !== h.id))
    void deliver(h.text, h.paths)
  }

  // A send while dictation listens waits for the last words (see submit).
  const submitLatest = useRef(submit)
  submitLatest.current = submit
  const sendOnEnd = useRef(false)
  // Set when Caprock stopped the listening (Send, the mic's second tap), so
  // an end the speech service chose itself is told apart.
  const stopAsked = useRef(false)
  // What was sent while the service was still finishing; words it hands
  // back after that go into the field rather than vanish or go twice.
  const sentAs = useRef<string | null>(null)
  const [recLang, setRecLang] = useState(lang)
  const endTimer = useRef(0)
  const flashTimer = useRef(0)
  useEffect(() => () => { window.clearTimeout(endTimer.current); window.clearTimeout(flashTimer.current) }, [])
  const flash = (msg: string) => {
    window.clearTimeout(flashTimer.current)
    setVoiceNote(msg)
    flashTimer.current = window.setTimeout(() => setVoiceNote((v) => (v === msg ? '' : v)), NOTICE_MS)
  }
  const finishSend = () => {
    window.clearTimeout(endTimer.current)
    if (!sendOnEnd.current) return
    sendOnEnd.current = false
    const said = textNow.current
    if (!said.trim() && attachedNow.current.length === 0) { flash(speechHint('no-speech')); return }
    if (!dictation.current) sentAs.current = null
    submitLatest.current(said)
  }
  const startRec = (): boolean => {
    beforeVoice.current = textNow.current
    sendOnEnd.current = false
    stopAsked.current = false
    sentAs.current = null
    const tag = speechLang()
    const d = startDictation({
      lang: tag,
      onText: (heard) => {
        const t = joinDictation(beforeVoice.current, heard)
        const sent = sentAs.current
        if (sent !== null) {
          const rest = t.startsWith(sent) ? t.slice(sent.length).trim() : ''
          if (rest) {
            textNow.current = rest
            setText(rest)
            flash('More words came after it was sent — they are in the field.')
          }
          return
        }
        textNow.current = t
        setText(t)
      },
      onEnd: (err) => {
        dictation.current = null
        setListening(false)
        const asked = stopAsked.current
        stopAsked.current = false
        if (sendOnEnd.current) finishSend()
        else if (err) setVoiceNote(speechHint(err))
        else if (!asked && textNow.current.trim()) setVoiceNote('Stopped listening — what was heard is in the field. Send it, or tap the mic to go on.')
      },
    })
    if (!d) { setVoiceNote(speechHint('missing')); return false }
    dictation.current = d
    setListening(true)
    setRecLang(tag)
    setVoiceNote('')
    return true
  }
  const heldList = (held.length > 0 || notice) && (
    <ul aria-live="polite" aria-label="Messages waiting" className="grid gap-1.5">
      {notice && <li className="rounded-sm border border-warn/50 bg-warn/10 px-2.5 py-1.5 text-[13px] text-fg">{notice}</li>}
      {held.map((h) => (
        <li key={h.id} className="flex min-w-0 items-center gap-2 rounded-sm border border-border-strong bg-panel-2 px-2.5 py-1.5 text-[13px]">
          <span className="min-w-0 flex-1">
            <span className={h.draft ? 'text-warn' : 'text-fg-muted'}>{h.draft ? `Not sent — ${h.draft}` : 'Will send when connected'}</span>
            <span className="block truncate mono text-fg">{heldLabel(h)}</span>
          </span>
          {h.draft && (
            <button
              type="button"
              disabled={!live}
              onClick={() => sendNow(h)}
              className="shrink-0 rounded-sm bg-accent px-3 py-2 min-h-[44px] text-[13px] font-medium text-bg hover:brightness-110 disabled:opacity-50"
            >
              {h.failed ? 'Retry' : 'Send now'}
            </button>
          )}
          <button
            type="button"
            onClick={() => edit(h)}
            aria-label={`Edit the message: ${heldLabel(h)}`}
            className="shrink-0 rounded-sm border border-border-strong px-3 py-2 min-h-[44px] text-[13px] text-fg hover:border-accent"
          >
            Edit
          </button>
        </li>
      ))}
    </ul>
  )

  const chipRow = attached.length > 0 && (
    <AttachedChips attached={attached} onRemove={(i) => { dropAttached(i); field.current?.focus() }} />
  )

  const photoInput = attach && (
    /* No `capture`: with it iOS opens only the camera; without it the
     * picker offers Take Photo and the photo library both. */
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
  )

  return (
    <div className="grid gap-2 border-t border-border px-2 py-2">
      {heldList}
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
        {chipRow}
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
          placeholder={placeholder ?? (pickers ? 'Type · / commands · @ files' : 'Type to the session…')}
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
          data-filled={text.trim() || attached.length > 0 ? '' : undefined}
          title={`${keys(INPUT_HIGHLIGHT_KEY)} turns the highlight off or on`}
          className="input composer-field w-full min-w-0 resize-none overflow-y-auto leading-snug"
          style={{ fontSize: 16, lineHeight: '22px', paddingTop: 10, paddingBottom: 10, maxHeight: FIELD_MAX_PX }}
        />
        {langIntro && !listening && !voiceNote && (
          <div role="status" className="text-[13px] leading-snug text-fg-muted">
            Dictation listens for <b className="font-medium text-fg">{langName(lang)}</b>. Tap <b className="font-medium text-accent">{langChip(lang)}</b> beside the mic to switch.
          </div>
        )}
        {(listening || voiceNote) && (
          <div role="status" aria-live="polite" className={`text-[13px] leading-snug ${listening ? 'text-fg' : 'text-fg-muted'}`}>
            {listening
              ? <><span className="text-danger">●</span> Listening in {langName(recLang)} — tap the mic again to stop, then Send. Your browser&apos;s speech service turns it into text.</>
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
            {photoInput}
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
          <span className="relative shrink-0">
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={tapLang}
              disabled={listening}
              aria-haspopup="menu"
              aria-expanded={langMenu}
              aria-label={`Dictation language: ${langName(lang)}. Tap to change`}
              title={`Dictation language: ${langName(lang)}`}
              data-testid="speech-lang"
              className={`flex h-12 w-11 items-center justify-center rounded-sm border text-[13px] font-medium disabled:opacity-50 ${langIntro || langMenu ? 'border-accent text-accent' : 'border-border-strong bg-panel-2 text-fg-muted hover:border-accent'}`}
            >
              {langChip(lang)}
            </button>
            {langMenu && <LangMenu current={lang} onPick={pickLang} onClose={() => setLangMenu(false)} />}
          </span>
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
          onClick={() => submit()}
          className="shrink-0 rounded-sm bg-accent px-4 py-2 min-h-[44px] text-[14px] font-medium text-bg hover:brightness-110"
        >
          Send
        </button>
        </div>
      </div>
      {/* Two rows of three below `sm`: in one row of six, "Ctrl+C" filled its
        * button edge to edge even at 390px. */}
      {keysOpen && <KeyGrid onKey={sendKey} />}
    </div>
  )
}

/**
 * The photos attached in the field, as Claude Code will show them once sent:
 * "Image 1", "Image 2", each with its preview and an × to take it out. The
 * path is the file Caprock saved; it is pasted on Send, never typed here.
 */
function AttachedChips({ attached, onRemove }: { attached: readonly Attached[]; onRemove: (i: number) => void }) {
  return (
    <ul aria-label="Attached photos" data-attached className="flex flex-wrap gap-1.5 px-0.5">
      {attached.map((a, i) => (
        <li key={`${a.path}-${i}`} className="flex h-9 items-center gap-1.5 rounded-[12px] border border-border-strong bg-panel-2 pl-1 pr-0.5 text-[14px] text-fg">
          {a.url
            ? <img src={a.url} alt="" className="h-7 w-7 rounded-[8px] object-cover" />
            : <span className="grid h-7 w-7 place-items-center"><PhotoIcon /></span>}
          <span>Image {i + 1}</span>
          <button
            type="button"
            aria-label={`Remove Image ${i + 1}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onRemove(i)}
            className="grid h-8 w-8 place-items-center rounded-full text-fg-muted hover:text-fg active:bg-panel"
          >
            <svg {...ICON} width={14} height={14}><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </li>
      ))}
    </ul>
  )
}

/**
 * Esc, Tab, the arrows, Enter and Ctrl+C as buttons: what a phone's keyboard
 * does not have and an agent's menus are answered with. Two rows of three
 * below `sm`: in one row of six, "Ctrl+C" filled its button edge to edge
 * even at 390px.
 */
export function KeyGrid({ onKey, className = '' }: { onKey: (bytes: string, label: string) => void; className?: string }) {
  return (
    <div className={`grid grid-cols-3 sm:grid-cols-6 gap-1.5 ${className}`} role="group" aria-label="Keys">
      {KEYS.map(([label, bytes, title]) => (
        <button
          key={label}
          type="button"
          title={title}
          aria-label={title}
          // Keep the field focused, so the keyboard does not drop and rise
          // between a key and the next word.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onKey(bytes, label)}
          className="min-h-[44px] min-w-0 rounded-sm border border-border-strong bg-panel-2 px-1 text-[13px] mono text-fg hover:border-accent active:bg-accent/15"
        >
          {label}
        </button>
      ))}
    </div>
  )
}

/** The dictation languages as a list of choices: this viewer's first, then the common ones. */
export function LangList({ current, onPick }: { current: string; onPick: (tag: string) => void }) {
  const mine = myLangs()
  const more = COMMON_SPEECH_LANGS.filter(([t]) => !mine.some((m) => m.split('-')[0] === t.split('-')[0]))
  const row = (tag: string, name: string) => (
    <button
      key={tag}
      type="button"
      role="menuitemradio"
      aria-checked={tag.toLowerCase() === current.toLowerCase()}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onPick(tag)}
      className={`flex min-h-11 w-full items-center gap-3 px-3 text-left text-[15px] hover:bg-panel-2 ${tag.toLowerCase() === current.toLowerCase() ? 'font-medium text-accent' : 'text-fg'}`}
    >
      <span className="w-7 shrink-0 text-[12px] text-fg-faint">{langChip(tag)}</span>
      {name}
    </button>
  )
  return (
    <>
      {mine.map((t) => row(t, langName(t)))}
      {more.length > 0 && <div className="border-t border-border px-3 pb-1 pt-2 text-[11px] uppercase tracking-wide text-fg-faint">More</div>}
      {more.map(([t, name]) => row(t, name))}
    </>
  )
}

/**
 * The dictation languages: this viewer's first, then the common ones. Opens
 * upwards from the chip, which sits at the bottom of the screen.
 */
function LangMenu({ current, onPick, onClose }: { current: string; onPick: (tag: string) => void; onClose: () => void }) {
  return (
    <>
      <div className="fixed inset-0 z-40" aria-hidden onClick={onClose} />
      <div role="menu" aria-label="Dictation language" className="absolute bottom-full right-0 z-50 mb-2 max-h-[50dvh] w-56 overflow-y-auto rounded-md border border-border-strong bg-panel py-1 shadow-lg">
        <LangList current={current} onPick={onPick} />
      </div>
    </>
  )
}

const ICON = { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }

function PhotoIcon() {
  return <svg {...ICON} className="text-fg-muted"><rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="9" cy="10" r="1.6" /><path d="M21 16l-5-5-8 8" /></svg>
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
