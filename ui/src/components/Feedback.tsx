/**
 * The feedback button, and the form behind it: what it is, a title, a few
 * words, screenshots — and out comes a GitHub issue the user submits.
 *
 * **The form.** Bug / Idea / Question as three large cards, each with its key
 * (1, 2, 3) and a label that exists on the repo, a required title that
 * becomes the issue's title, an optional description, screenshots pasted (⌘V anywhere in the
 * dialog), dropped or chosen — up to four, a thumbnail each with a × — and a
 * one-line "Included: version, OS…" that opens to show exactly what the
 * diagnostics say, with a box to leave them out.
 *
 * **Quick from the keyboard** (owner, 2026-10-11: "big options, quick choice,
 * choosable with keys, quick to write"). The title has focus on open. 1, 2, 3
 * pick the kind by physical key (`kindForCode`, so any layout) wherever a
 * keystroke would not be text — outside a field, or in the title while it is
 * still empty — and focus lands in the title; arrows move between the cards.
 * Enter in the title goes on to the description, ⌘↩ (Ctrl+Enter off macOS)
 * creates the issue from anywhere, Esc closes.
 *
 * **Nothing is transmitted from here.** *Create issue* opens a prefilled
 * GitHub issue in the browser; the user reads it, edits it, submits it. A
 * URL cannot carry a file and Caprock uploads nothing (CLAUDE.md rule 4), so
 * screenshots go by clipboard: the first is put there as the issue opens,
 * the dialog turns into a small *Attach your screenshots* step — "Screenshot
 * 1 is on your clipboard — press ⌘V in the GitHub comment box" — and *Copy
 * next* puts the next one there. GitHub uploads what is pasted into its own
 * page. `lib/attachments.ts` has the why of each detail.
 *
 * **Where it is.** A labelled button with a megaphone in the dashboard's
 * header, and in the desktop app also an icon beside Settings in the
 * sidebar's bottom bar, which is on screen whatever tab is in front. It was
 * an 11px grey word among the header's chips, and the owner never noticed
 * it (2026-10-10). ⇧⌘F (Ctrl+Alt+Shift+F off macOS) opens the form from
 * anywhere in the app, AppShell holding that dialog; the sidebar row draws
 * the key (owner, 2026-10-14).
 *
 * **How the issue opens.** Through `openExternal` (lib/nudges.ts): the desktop
 * app's `open_external` command, which hands the URL to the default browser,
 * and `window.open` in a browser tab.
 *
 * **In the desktop app** three things go through the shell
 * (app/src-tauri/src/capture.rs) rather than the webview: the clipboard
 * (`clipboard_image`), **Capture window** — the app's own page drawn by its
 * webview, never the screen, so no Screen Recording permission; on macOS and
 * Windows, hidden on Linux and in a browser — and a file dropped on the
 * window, which reaches the page as a path and is read by the shell only if
 * it is an image of at most 10 MB from that very drop.
 */
import { useCallback, useEffect, useRef, useState, type DragEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { api } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { openExternal } from '@/lib/nudges'
import { isAppMode, isMacPlatform } from '@/lib/appmode'
import { context, currentScreen, isSendable, issueURL, kindForCode, KINDS, type FeedbackKind } from '@/lib/feedback'
import { keys } from '@/lib/appkeys'
import { useChipFit } from '@/lib/keyChipFit'
import { accept, baseName, copyImage, imageTypeOfPath, imagesIn, MAX_SHOTS, nextShot, stepLine, toPNG, type Shot } from '@/lib/attachments'
import { captureSupported, shell } from '@/lib/shell'
import { DROP_PATHS_EVENT } from '@/lib/xtermInput'
import { BugIcon, LightbulbIcon, QuestionIcon } from './AppIcons'
import { CloseButton, DialogBackdrop } from './Dialog'
import { KeyChip } from './Sheet'

const TIP = 'Report a bug, suggest an idea, or ask a question'
/** The form's key from anywhere in the app (AppShell, lib/appkeys), in macOS spelling. */
export const FEEDBACK_KEY = '⇧⌘F'
const KEY = FEEDBACK_KEY

/** Each kind's card glyph and its colour, from the theme's tokens: the bug is
 *  the warning hue (graphite's amber, Slate's cool yellow), the idea the green
 *  of "working", the question the plain ink. */
const GLYPHS: Record<FeedbackKind, { Glyph: typeof BugIcon; tone: string }> = {
  bug: { Glyph: BugIcon, tone: 'text-warn' },
  idea: { Glyph: LightbulbIcon, tone: 'text-ok' },
  question: { Glyph: QuestionIcon, tone: 'text-fg' },
}

/** Whether a keystroke on `el` is text being written, so 1 2 3 must type
 *  rather than pick a kind. An empty title is not writing yet: that is where
 *  focus sits when the dialog opens, and the first thing a person does there
 *  is choose. */
function isWriting(el: EventTarget | null, title: HTMLInputElement | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  if (el instanceof HTMLTextAreaElement || el.isContentEditable) return true
  if (!(el instanceof HTMLInputElement)) return false
  if (el.type === 'checkbox' || el.type === 'file') return false
  return !(el === title && el.value === '')
}

/**
 * The labelled row in the app sidebar's footer. The hint ("bug, idea,
 * question") gives way first; when the words and the key still do not both
 * fit, the key is left out whole and stays in the tooltip (owner,
 * 2026-10-15, translated: "the shortcuts there are tiny, you can't see a
 * damn thing"). Off macOS that is Ctrl+Alt+Shift+F, ~140px. The words never
 * shrink: a shrinkable label lost a subpixel to the hint and drew "…".
 */
function FeedbackRow({ onClick }: { onClick: () => void }) {
  const [ref, fits] = useChipFit<HTMLButtonElement>()
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      title={`${TIP} (${keys(KEY)})`}
      aria-label="Send feedback"
      aria-keyshortcuts={ariaKeys()}
      className="app-row relative flex h-[28px] w-full items-center gap-2 rounded-[7px] px-2 text-left text-[12.5px] text-fg-muted hover:text-fg"
    >
      <BugIcon size={15} className="shrink-0 text-accent" />
      <span data-key-label className="shrink-0 whitespace-nowrap">Send feedback</span>
      <span data-key-give className="min-w-0 flex-auto shrink-[100] truncate text-[11px] text-fg-faint">bug, idea, question</span>
      <kbd aria-hidden data-key-chip data-dropped={fits ? undefined : ''} className={`app-kbd-key shrink-0 ${fits ? '' : 'pointer-events-none invisible absolute'}`}>{keys(KEY)}</kbd>
    </button>
  )
}

/**
 * `header`: the labelled button in the dashboard's header. `row`: the
 * labelled row in the app sidebar's bottom block. `icon`: an icon button
 * for that block when it is collapsed, sized by `className` and `iconSize`
 * (26px and 15 without them). `screen` names where the
 * report comes from; without it, the screen in front when the dialog opens.
 */
export function FeedbackButton({ screen, variant = 'header', className, iconSize = 15 }: { screen?: string; variant?: 'header' | 'row' | 'icon'; className?: string; iconSize?: number }) {
  const [open, setOpen] = useState<string | null>(null)
  const show = () => setOpen(screen ?? currentScreen(location.hash, isAppMode()))
  return (
    <>
      {variant === 'icon' ? (
        <button
          type="button"
          onClick={show}
          title={`${TIP} (${keys(KEY)})`}
          aria-label="Send feedback"
          aria-keyshortcuts={ariaKeys()}
          className={className ?? 'flex h-[26px] w-[26px] items-center justify-center rounded-[6px] text-fg-muted transition-colors hover:bg-[var(--app-row-hover)] hover:text-fg motion-reduce:transition-none'}
        >
          <BugIcon size={iconSize} className="text-accent" />
        </button>
      ) : variant === 'row' ? (
        <FeedbackRow onClick={show} />
      ) : (
        <button
          type="button"
          onClick={show}
          title={TIP}
          className="inline-flex h-[24px] items-center gap-1.5 rounded-[6px] border border-border-strong bg-panel-2/60 px-2 text-[12px] font-medium text-fg transition-colors hover:border-accent/60 hover:text-accent motion-reduce:transition-none"
        >
          <BugIcon size={14} className="text-accent" />
          Feedback
        </button>
      )}
      {open !== null && <FeedbackDialog screen={open} onClose={() => setOpen(null)} />}
    </>
  )
}

/** The key as `aria-keyshortcuts` writes it, on this platform. */
function ariaKeys(): string {
  return isMacPlatform() ? 'Meta+Shift+F' : 'Control+Alt+Shift+F'
}

let shotSeq = 0

export function FeedbackDialog({ screen, onClose }: { screen: string; onClose: () => void }) {
  const [kind, setKind] = useState<FeedbackKind>('bug')
  const [titleText, setTitleText] = useState('')
  const [text, setText] = useState('')
  const [shots, setShots] = useState<Shot[]>([])
  const [note, setNote] = useState('')
  const [withDiag, setWithDiag] = useState(true)
  const [showDiag, setShowDiag] = useState(false)
  const [dragging, setDragging] = useState(false)
  /** While the window is being captured the dialog is hidden, so the shot shows the app. */
  const [capturing, setCapturing] = useState(false)
  const canCapture = captureSupported()
  /** Set once the issue is open and there are screenshots to carry over. */
  const [step, setStep] = useState<{ i: number; copied: boolean; saved?: boolean } | null>(null)
  const status = useApi(() => api.status(), [], { live: false, intervalMs: 0 })
  const ctx = context(status.data, screen)
  const ready = isSendable(titleText)
  const active = KINDS.find((k) => k.id === kind) ?? KINDS[0]!
  const isMac = isMacPlatform()
  const pasteKey = isMac ? '⌘V' : 'Ctrl+V'
  const picker = useRef<HTMLInputElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const descRef = useRef<HTMLTextAreaElement>(null)
  const cards = useRef<(HTMLButtonElement | null)[]>([])
  const submitKey = keys('⌘↩', isMac)
  // Pending conversions count against the cap too, so a fast double paste
  // cannot slip a fifth image in while the first four are being drawn.
  const count = useRef(0)

  const add = useCallback(async (files: File[], also = '') => {
    const { take, note: why } = accept(count.current, files)
    setNote([also, why].filter(Boolean).join(' '))
    if (take.length === 0) return
    count.current += take.length
    const made = await Promise.all(take.map(async (f) => ({
      id: ++shotSeq,
      png: await toPNG(f),
      url: URL.createObjectURL(f),
      name: f.name || 'screenshot.png',
    })))
    setShots((s) => [...s, ...made])
  }, [])

  const remove = (id: number) => {
    setShots((s) => {
      const gone = s.find((x) => x.id === id)
      if (gone) URL.revokeObjectURL(gone.url)
      return s.filter((x) => x.id !== id)
    })
    count.current = Math.max(0, count.current - 1)
    setNote('')
  }

  // Thumbnails' object URLs go with the dialog.
  const shotsRef = useRef(shots)
  shotsRef.current = shots
  useEffect(() => () => { for (const s of shotsRef.current) URL.revokeObjectURL(s.url) }, [])

  // ⌘V anywhere while the form is up: in the title, the description, or
  // with nothing focused at all. Text pastes are left alone.
  useEffect(() => {
    if (step) return
    const onPaste = (e: ClipboardEvent) => {
      const imgs = imagesIn(e.clipboardData)
      if (imgs.length === 0) return
      e.preventDefault()
      void add(imgs)
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [add, step])

  // In the desktop app a file dropped from Finder reaches the page as a path
  // (lib/xtermInput.ts), not bytes; the shell reads it for us if it is an
  // image from that drop. Anything else gets the same short note as a paste.
  useEffect(() => {
    if (step) return
    const onPaths = (e: Event) => {
      const d = (e as CustomEvent<{ paths?: unknown } | undefined>).detail
      const paths = Array.isArray(d?.paths) ? d.paths.filter((p): p is string => typeof p === 'string') : []
      if (paths.length === 0) return
      void (async () => {
        const files: File[] = []
        let refused = ''
        for (const p of paths) {
          const type = imageTypeOfPath(p)
          if (!type) { refused = 'Only images can be attached.'; continue }
          try {
            const bytes = await shell.readDroppedImage(p)
            files.push(new File([bytes], baseName(p), { type }))
          } catch {
            refused = 'An image over 10 MB, or one that could not be read, was left out.'
          }
        }
        await add(files, refused)
      })()
    }
    window.addEventListener(DROP_PATHS_EVENT, onPaths)
    return () => window.removeEventListener(DROP_PATHS_EVENT, onPaths)
  }, [add, step])

  // The dialog steps aside for a frame or two so the capture shows the app,
  // then comes back with the shot attached.
  const capture = async () => {
    setCapturing(true)
    try {
      await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 50))))
      const bytes = await shell.captureWindow()
      setCapturing(false)
      await add([new File([bytes], 'caprock-window.png', { type: 'image/png' })])
    } catch {
      setCapturing(false)
      setNote(`Could not capture the window — paste a screenshot (${pasteKey}) instead.`)
    }
  }

  const onDragOver = (e: DragEvent) => {
    if (!Array.from(e.dataTransfer?.types ?? []).includes('Files')) return
    e.preventDefault()
    setDragging(true)
  }
  const onDrop = (e: DragEvent) => {
    setDragging(false)
    const imgs = Array.from(e.dataTransfer?.files ?? [])
    if (imgs.length === 0) return
    e.preventDefault()
    void add(imgs)
  }

  const send = () => {
    if (!ready) return
    const url = issueURL({ kind, title: titleText, text, ctx: withDiag ? ctx : null, shots: shots.length, pasteKey })
    if (shots.length === 0) {
      openExternal(url)
      onClose()
      return
    }
    // The copy starts first, inside the click; then the browser opens.
    const copying = copyImage(shots[0]!.png)
    openExternal(url)
    setStep({ i: 0, copied: true })
    void copying.then((ok) => setStep((s) => (s && s.i === 0 ? { ...s, copied: ok } : s)))
  }

  /** A kind chosen by click or key: focus goes straight to the title. */
  const pick = (k: FeedbackKind) => {
    setKind(k)
    titleRef.current?.focus()
  }

  // ⌘↩ / Ctrl+Enter creates the issue from anywhere in the form; 1 2 3 pick
  // the kind wherever the key would not be typed text. Modified digits are
  // left alone: ⌘1 is a tab, Shift+1 a "!".
  const onFormKey = (e: ReactKeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); send(); return }
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.nativeEvent.isComposing) return
    const k = kindForCode(e.code)
    if (k && !isWriting(e.target, titleRef.current)) { e.preventDefault(); pick(k) }
  }

  // Arrows move between the cards, as in any radio group; the choice follows.
  const onCardsKey = (e: ReactKeyboardEvent) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (step === 0) return
    e.preventDefault()
    const i = (KINDS.findIndex((k) => k.id === kind) + step + KINDS.length) % KINDS.length
    setKind(KINDS[i]!.id)
    cards.current[i]?.focus()
  }

  const copyAt = (i: number) => {
    const copying = copyImage(shots[i]!.png)
    setStep({ i, copied: true })
    void copying.then((ok) => setStep((s) => (s && s.i === i ? { ...s, copied: ok } : s)))
  }

  // The way out when the clipboard refuses: every screenshot as a file, to
  // drag into GitHub's comment box. Never a dead end.
  const saveAll = () => {
    shots.forEach((s, i) => {
      const a = document.createElement('a')
      a.href = URL.createObjectURL(s.png)
      a.download = `caprock-feedback-${i + 1}.png`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
    })
    setStep((st) => (st ? { ...st, saved: true } : st))
  }

  return (
    <DialogBackdrop
      onClose={onClose}
      className={`fixed inset-0 z-30 bg-black/50 flex items-start justify-center pt-[10vh] px-4 ${capturing ? 'invisible' : ''}`}
      aria-busy={capturing || undefined}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Feedback"
        onDragOver={step ? undefined : onDragOver}
        onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false) }}
        onDrop={step ? undefined : onDrop}
        className={`w-full max-w-[680px] border bg-panel rounded-[var(--radius-panel)] shadow-lg ${
          dragging ? 'border-accent' : 'border-border-strong'
        }`}
      >
        <div className="pl-5 pr-2.5 py-2.5 border-b border-border flex items-center">
          <span className="text-[17px] font-medium">{step ? 'Attach your screenshots' : 'Send feedback'}</span>
          <CloseButton onClick={onClose} className="ml-auto" />
        </div>

        {step ? (
          <div className="p-5 grid gap-4">
            <p className="text-[14.5px] leading-relaxed" role="status">
              {stepLine(step.i, shots.length, step.copied, pasteKey, !!step.saved)}
            </p>
            <div className="flex gap-2">
              {shots.map((s, i) => (
                <img
                  key={s.id}
                  src={s.url}
                  alt={`Screenshot ${i + 1}`}
                  className={`h-16 w-24 rounded-[5px] border object-cover ${
                    i === step.i ? 'border-accent ring-1 ring-accent' : 'border-border opacity-60'
                  }`}
                />
              ))}
            </div>
            <div className="flex items-center gap-2">
              {step.copied && shots.length > 1 && (
                <button
                  type="button"
                  onClick={() => copyAt(nextShot(step.i, shots.length))}
                  className="rounded-[6px] border border-border-strong px-3 py-1 text-[14px] text-fg hover:border-accent/60 hover:text-accent"
                >
                  Copy next ({nextShot(step.i, shots.length) + 1} of {shots.length})
                </button>
              )}
              {!step.copied && (
                <button
                  type="button"
                  onClick={saveAll}
                  className="rounded-[6px] border border-border-strong px-3 py-1 text-[14px] text-fg hover:border-accent/60 hover:text-accent"
                >
                  {step.saved ? 'Saved — save again' : shots.length > 1 ? 'Save screenshots' : 'Save screenshot'}
                </button>
              )}
              <button
                type="button"
                onClick={onClose}
                className="ml-auto rounded-[6px] bg-accent px-3.5 py-1 text-[14px] font-medium text-panel hover:brightness-110"
              >
                Done
              </button>
            </div>
            <p className="text-[13px] text-fg-faint leading-relaxed">
              The issue is open in your browser. GitHub uploads what you paste
              there; Caprock sends nothing.
            </p>
          </div>
        ) : (
          <form
            className="px-5 pt-4 pb-4 grid gap-3.5"
            onSubmit={(e) => { e.preventDefault(); send() }}
            onKeyDown={onFormKey}
          >
            {/* Three big cards, one row (owner, 2026-10-11: "big options,
              * with icons, quick choice, choosable with keys"). A segmented
              * control of three small words until then. The key is drawn as
              * every key in the app is (.app-kbd-key, tokens.css). */}
            <div className="grid grid-cols-3 gap-2.5 max-sm:gap-1.5" role="radiogroup" aria-label="What is it" data-feedback-kinds="" onKeyDown={onCardsKey}>
              {KINDS.map((k, i) => {
                const { Glyph, tone } = GLYPHS[k.id]
                const on = k.id === kind
                return (
                  <button
                    key={k.id}
                    ref={(el) => { cards.current[i] = el }}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    aria-label={k.label}
                    aria-keyshortcuts={String(i + 1)}
                    tabIndex={on ? 0 : -1}
                    onClick={() => pick(k.id)}
                    className={`relative flex items-center gap-3 rounded-[9px] border px-3.5 py-3 text-left transition-colors motion-reduce:transition-none max-sm:flex-col max-sm:items-start max-sm:gap-1.5 max-sm:px-2.5 ${
                      on ? 'border-accent bg-accent/10' : 'border-border-strong bg-panel-2/40 hover:border-fg-muted'
                    }`}
                  >
                    <Glyph size={30} className={tone} />
                    <span className="grid min-w-0 flex-1 gap-0.5">
                      <span className={`text-[17px] font-semibold leading-tight ${on ? 'text-fg' : 'text-fg-muted'}`}>{k.label}</span>
                      <span className="truncate text-[12.5px] text-fg-muted max-sm:hidden">{k.blurb}</span>
                    </span>
                    <kbd aria-hidden className="app-kbd-key absolute right-2.5 top-2.5">{i + 1}</kbd>
                  </button>
                )
              })}
            </div>

            <label className="grid gap-1">
              <span className="text-[13px] font-medium text-fg-muted">Title</span>
              {/* Autofocused: the fewer deliberate actions between "I noticed
                * something" and typing it, the more reports get written.
                * Enter goes on to the description rather than submitting a
                * half-written report. Prose, so the sans face: `.input` sets
                * mono outside any layer, where a font utility cannot reach it. */}
              <input
                ref={titleRef}
                autoFocus
                value={titleText}
                onChange={(e) => setTitleText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.nativeEvent.isComposing) return
                  e.preventDefault()
                  descRef.current?.focus()
                }}
                placeholder={active.title}
                maxLength={256}
                className="input w-full text-[15.5px] py-1.5"
                style={{ fontFamily: 'var(--font-sans)' }}
              />
            </label>

            <label className="grid gap-1">
              <span className="text-[13px] font-medium text-fg-muted">Description <span className="text-fg-faint">— optional</span></span>
              <textarea
                ref={descRef}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={active.hint}
                rows={3}
                className="input w-full resize-y text-[15px] leading-relaxed"
                style={{ fontFamily: 'var(--font-sans)' }}
              />
            </label>

            <div className="grid gap-1.5">
              <div className="flex flex-wrap items-center gap-2">
                {shots.map((s, i) => (
                  <div key={s.id} className="relative">
                    <img src={s.url} alt={`Screenshot ${i + 1}`} className="h-14 w-20 rounded-[5px] border border-border object-cover" />
                    <button
                      type="button"
                      aria-label={`Remove screenshot ${i + 1}`}
                      title="Remove"
                      onClick={() => remove(s.id)}
                      className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-border-strong bg-panel text-[13.5px] leading-none text-fg-muted hover:text-fg"
                    >
                      ×
                    </button>
                  </div>
                ))}
                {shots.length < MAX_SHOTS && (
                  <button
                    type="button"
                    onClick={() => picker.current?.click()}
                    className={`flex h-14 items-center gap-1.5 rounded-[5px] border border-dashed px-3 text-[13.5px] ${
                      dragging ? 'border-accent text-accent' : 'border-border-strong text-fg-muted hover:text-fg hover:border-fg-muted'
                    } ${shots.length === 0 ? 'flex-1 justify-center' : 'w-20 justify-center'}`}
                  >
                    {shots.length === 0
                      ? <>Add screenshots — paste ({pasteKey}), drop, or <span className="underline underline-offset-2">choose</span></>
                      : '+ Add'}
                  </button>
                )}
                {canCapture && shots.length < MAX_SHOTS && (
                  <button
                    type="button"
                    onClick={() => void capture()}
                    title="Attach a picture of this window — the app only, not your screen"
                    className="flex h-14 shrink-0 items-center justify-center rounded-[5px] border border-dashed border-border-strong px-3 text-[13.5px] text-fg-muted hover:text-fg hover:border-fg-muted"
                  >
                    Capture window
                  </button>
                )}
                <input
                  ref={picker}
                  type="file"
                  accept="image/*"
                  multiple
                  hidden
                  aria-label="Choose screenshots"
                  onChange={(e) => {
                    void add(Array.from(e.target.files ?? []))
                    e.target.value = ''
                  }}
                />
              </div>
              {note && <p className="text-[13px] text-warn" role="status">{note}</p>}
            </div>

            <div className="text-[13px] text-fg-muted">
              <div className="flex items-center gap-2">
                <label className="inline-flex items-center gap-1.5">
                  <input type="checkbox" checked={withDiag} onChange={(e) => setWithDiag(e.target.checked)} className="accent-[var(--color-accent)]" />
                  Include diagnostics
                </label>
                <button
                  type="button"
                  aria-expanded={showDiag}
                  onClick={() => setShowDiag((v) => !v)}
                  className={`text-fg-faint hover:text-fg ${withDiag ? '' : 'line-through'}`}
                >
                  {showDiag ? '▾' : '▸'} version, OS, screen, scale, hooks
                </button>
              </div>
              {showDiag && (
                <ul className="mt-1.5 ml-5 grid gap-0.5 text-[13px] text-fg-faint num">
                  {ctx.map((c) => <li key={c}>{c}</li>)}
                </ul>
              )}
            </div>

            <div className="flex items-center gap-3 border-t border-border pt-3">
              <span className="text-[13px] text-fg-muted leading-snug">
                Opens a prefilled issue in your browser. Nothing is sent from here.
              </span>
              <button
                type="submit"
                disabled={!ready}
                title={submitKey}
                aria-keyshortcuts={isMac ? 'Meta+Enter' : 'Control+Enter'}
                className="ml-auto inline-flex h-[34px] shrink-0 items-center gap-2 rounded-[7px] bg-accent px-4 text-[14px] font-medium text-panel hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Create issue
                <KeyChip primary>{submitKey}</KeyChip>
              </button>
            </div>
          </form>
        )}
      </div>
    </DialogBackdrop>
  )
}
