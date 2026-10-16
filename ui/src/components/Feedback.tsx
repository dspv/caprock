/**
 * The feedback button, and the one box behind it: say what is wrong, drop a
 * screenshot, send (owner, 2026-10-16, translated: "as short as humanly
 * possible: just type what's wrong, maybe drop a screenshot, and send").
 *
 * **The sheet.** One autofocused box, *What's wrong?*; the whole sheet is the
 * drop zone (an image dropped anywhere on it, or ⌘V of one anywhere while it
 * is up — a text paste is left alone); a thumbnail with a × per image, up to
 * four; **Send** (⌘↩, Ctrl+Enter off macOS). Under them one quiet line says
 * what goes where, and a small *Details* opens the rest: the kind (Bug unless
 * changed), the diagnostics with a box to leave them out, *Choose image…*
 * and, in the app on macOS and Windows, *Capture window*. Nothing is
 * required but a few words, or a screenshot on its own. The first line of
 * the box becomes the issue's title (`fromBox`, lib/feedback.ts).
 *
 * **The draft is kept** per viewer in localStorage until it is sent: Escape,
 * the × or a click outside close the sheet and the words are there next time.
 *
 * **Nothing is transmitted from here.** *Send* opens a prefilled GitHub issue
 * in the browser; the user submits it there. A URL cannot carry a file and
 * Caprock uploads nothing (CLAUDE.md rule 4), so screenshots go by
 * clipboard: the first is put there as the issue opens, and the sheet turns
 * into a small *Attach your screenshots* step — "Screenshot 1 is on your
 * clipboard — press ⌘V in the GitHub comment box" — with *Copy next*.
 * Without screenshots the sheet says *Opened on GitHub — thanks* and closes.
 * If the browser cannot be reached, the words stay and *Retry* is offered.
 * `lib/attachments.ts` has the why of each detail.
 *
 * **Where it is.** A labelled button in the dashboard's header, and in the
 * desktop app the *Send feedback* row (or icon) in the sidebar's bottom
 * block. ⇧⌘F (Ctrl+Alt+Shift+F off macOS) opens it from anywhere in the app,
 * AppShell holding that dialog; the phone bar opens it too.
 *
 * **How the issue opens.** Through `openExternal` (lib/nudges.ts): the desktop
 * app's `open_external` command, which hands the URL to the default browser,
 * and `window.open` in a browser tab.
 *
 * **In the desktop app** three things go through the shell
 * (app/src-tauri/src/capture.rs): the clipboard (`clipboard_image`), Capture
 * window (the app's own page drawn by its webview, never the screen, so no
 * Screen Recording permission; hidden on Linux and in a browser), and a file
 * dropped on the window, which reaches the page as a path
 * (`DROP_PATHS_EVENT`, lib/xtermInput.ts) and is read by the shell only if it
 * is an image of at most 10 MB from that very drop.
 */
import { useCallback, useEffect, useRef, useState, type DragEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { api } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { openExternal } from '@/lib/nudges'
import { isAppMode, isMacPlatform } from '@/lib/appmode'
import { context, currentScreen, fromBox, isSendable, issueURL, KINDS, type FeedbackKind } from '@/lib/feedback'
import { keys } from '@/lib/appkeys'
import { useChipFit } from '@/lib/keyChipFit'
import { accept, baseName, copyImage, imageTypeOfPath, imagesIn, MAX_SHOTS, nextShot, stepLine, toPNG, type Shot } from '@/lib/attachments'
import { captureSupported, shell } from '@/lib/shell'
import { DROP_PATHS_EVENT } from '@/lib/xtermInput'
import { BugIcon } from './AppIcons'
import { CloseButton, DialogBackdrop } from './Dialog'
import { KeyChip } from './Sheet'

const TIP = 'Say what’s wrong, drop a screenshot, send'
/** The form's key from anywhere in the app (AppShell, lib/appkeys), in macOS spelling. */
export const FEEDBACK_KEY = '⇧⌘F'
const KEY = FEEDBACK_KEY

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

/** Where the draft waits between openings, per viewer. */
export const DRAFT_KEY = 'caprock.feedback.draft'

function readDraft(): string {
  try { return localStorage.getItem(DRAFT_KEY) ?? '' } catch { return '' }
}
function writeDraft(text: string) {
  try {
    if (text) localStorage.setItem(DRAFT_KEY, text)
    else localStorage.removeItem(DRAFT_KEY)
  } catch { /* storage refused: the draft lives as long as the sheet */ }
}

/** How long *Opened on GitHub — thanks* stays before the sheet closes. */
export const THANKS_MS = 1200

let shotSeq = 0

export function FeedbackDialog({ screen, onClose }: { screen: string; onClose: () => void }) {
  const [box, setBox] = useState(readDraft)
  const [kind, setKind] = useState<FeedbackKind>('bug')
  const [shots, setShots] = useState<Shot[]>([])
  const [note, setNote] = useState('')
  const [withDiag, setWithDiag] = useState(true)
  const [details, setDetails] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [failed, setFailed] = useState(false)
  const [thanks, setThanks] = useState(false)
  /** While the window is being captured the dialog is hidden, so the shot shows the app. */
  const [capturing, setCapturing] = useState(false)
  const canCapture = captureSupported()
  /** Set once the issue is open and there are screenshots to carry over. */
  const [step, setStep] = useState<{ i: number; copied: boolean; saved?: boolean } | null>(null)
  const status = useApi(() => api.status(), [], { live: false, intervalMs: 0 })
  const ctx = context(status.data, screen)
  const ready = isSendable(box, shots.length)
  const isMac = isMacPlatform()
  const pasteKey = isMac ? '⌘V' : 'Ctrl+V'
  const picker = useRef<HTMLInputElement>(null)
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

  // The sheet closes itself a moment after the thanks.
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    if (!thanks) return
    const t = setTimeout(() => closeRef.current(), THANKS_MS)
    return () => clearTimeout(t)
  }, [thanks])

  // ⌘V anywhere while the sheet is up: in the box or with nothing focused.
  // Text pastes are left alone.
  useEffect(() => {
    if (step || thanks) return
    const onPaste = (e: ClipboardEvent) => {
      const imgs = imagesIn(e.clipboardData)
      if (imgs.length === 0) return
      e.preventDefault()
      void add(imgs)
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [add, step, thanks])

  // In the desktop app a file dropped from Finder reaches the page as a path
  // (lib/xtermInput.ts), not bytes; the shell reads it for us if it is an
  // image from that drop. Anything else gets the same short note as a paste.
  useEffect(() => {
    if (step || thanks) return
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
  }, [add, step, thanks])

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

  const edit = (text: string) => {
    setBox(text)
    setFailed(false)
    writeDraft(text)
  }

  const send = () => {
    if (!ready || thanks) return
    const { title, text } = fromBox(box, screen)
    const url = issueURL({ kind, title, text, ctx: withDiag ? ctx : null, shots: shots.length, pasteKey })
    // The copy starts first, inside the click (WebKit allows a clipboard
    // write only there); then the browser opens.
    const copying = shots.length > 0 ? copyImage(shots[0]!.png) : null
    try {
      openExternal(url)
    } catch {
      setFailed(true)
      return
    }
    setFailed(false)
    writeDraft('')
    if (!copying) { setThanks(true); return }
    setStep({ i: 0, copied: true })
    void copying.then((ok) => setStep((s) => (s && s.i === 0 ? { ...s, copied: ok } : s)))
  }

  // ⌘↩ / Ctrl+Enter sends from anywhere on the sheet; a bare Enter is a new line.
  const onKey = (e: ReactKeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); send() }
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

  const quiet = 'rounded-[6px] border border-border-strong px-3 py-1 text-[13.5px] text-fg hover:border-accent/60 hover:text-accent'
  const live = !step && !thanks

  return (
    <DialogBackdrop
      onClose={onClose}
      className={`fixed inset-0 z-30 bg-black/50 flex items-start justify-center pt-[12vh] px-4 ${capturing ? 'invisible' : ''}`}
      aria-busy={capturing || undefined}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Feedback"
        data-feedback-sheet=""
        onDragOver={live ? onDragOver : undefined}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false) }}
        onDrop={live ? onDrop : undefined}
        onKeyDown={live ? onKey : undefined}
        className={`relative w-full max-w-[560px] border bg-panel rounded-[var(--radius-panel)] shadow-lg ${
          dragging ? 'border-accent' : 'border-border-strong'
        }`}
      >
        {dragging && (
          <div aria-hidden className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[var(--radius-panel)] bg-accent/10 text-[15px] font-medium text-accent">
            Drop to attach
          </div>
        )}

        {step ? (
          <div className="p-5 grid gap-4">
            <div className="flex items-center">
              <span className="text-[16px] font-medium">Attach your screenshots</span>
              <CloseButton onClick={onClose} className="ml-auto -mr-2" />
            </div>
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
                <button type="button" onClick={() => copyAt(nextShot(step.i, shots.length))} className={quiet}>
                  Copy next ({nextShot(step.i, shots.length) + 1} of {shots.length})
                </button>
              )}
              {!step.copied && (
                <button type="button" onClick={saveAll} className={quiet}>
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
          </div>
        ) : thanks ? (
          <p className="px-5 py-6 text-center text-[15px] font-medium" role="status">Opened on GitHub — thanks</p>
        ) : (
          <form className="p-3 grid gap-2.5" onSubmit={(e) => { e.preventDefault(); send() }}>
            <div className="relative">
              {/* Autofocused: the fewer deliberate actions between "I noticed
                * something" and typing it, the more reports get written.
                * Prose, so the sans face: `.input` sets mono outside any
                * layer, where a font utility cannot reach it. */}
              <textarea
                autoFocus
                aria-label="What's wrong?"
                value={box}
                onChange={(e) => edit(e.target.value)}
                placeholder={`What's wrong? Drop or paste (${pasteKey}) a screenshot anywhere here.`}
                rows={4}
                className="input w-full resize-y pr-10 text-[15.5px] leading-relaxed"
                style={{ fontFamily: 'var(--font-sans)' }}
              />
              <CloseButton onClick={onClose} className="absolute right-0.5 top-0.5" />
            </div>

            {shots.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 px-0.5 pt-1">
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
              </div>
            )}
            {note && <p className="px-0.5 text-[13px] text-warn" role="status">{note}</p>}

            {details && (
              <div className="grid gap-2 rounded-[7px] border border-border px-3 py-2.5 text-[13px] text-fg-muted" data-feedback-details="">
                <div className="flex items-center gap-1" role="radiogroup" aria-label="What is it">
                  {KINDS.map((k) => (
                    <button
                      key={k.id}
                      type="button"
                      role="radio"
                      aria-checked={k.id === kind}
                      onClick={() => setKind(k.id)}
                      className={`rounded-[5px] border px-2 py-0.5 ${k.id === kind ? 'border-accent bg-accent/10 text-fg' : 'border-border-strong hover:text-fg'}`}
                    >
                      {k.label}
                    </button>
                  ))}
                </div>
                <label className="inline-flex items-center gap-1.5">
                  <input type="checkbox" checked={withDiag} onChange={(e) => setWithDiag(e.target.checked)} className="accent-[var(--color-accent)]" />
                  Include diagnostics
                </label>
                <ul className={`ml-5 grid gap-0.5 text-fg-faint num ${withDiag ? '' : 'line-through'}`}>
                  {ctx.map((c) => <li key={c}>{c}</li>)}
                </ul>
                {shots.length < MAX_SHOTS && (
                  <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={() => picker.current?.click()} className={quiet}>Choose image…</button>
                    {canCapture && (
                      <button
                        type="button"
                        onClick={() => void capture()}
                        title="Attach a picture of this window — the app only, not your screen"
                        className={quiet}
                      >
                        Capture window
                      </button>
                    )}
                  </div>
                )}
              </div>
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

            <div className="flex items-center gap-3 px-0.5">
              <span className="min-w-0 text-[12.5px] leading-snug text-fg-faint">
                {failed ? (
                  <span className="text-warn" role="alert">Could not open the browser. Your words are kept.</span>
                ) : (
                  <>Opens a GitHub issue in your browser{withDiag ? ', with version and OS' : ''}; you submit it there.</>
                )}
                {' '}
                <button
                  type="button"
                  aria-expanded={details}
                  onClick={() => setDetails((v) => !v)}
                  className="whitespace-nowrap text-fg-muted underline-offset-2 hover:text-fg hover:underline"
                >
                  {details ? 'Hide details' : 'Details'}
                </button>
              </span>
              <button
                type="submit"
                disabled={!ready}
                title={submitKey}
                aria-keyshortcuts={isMac ? 'Meta+Enter' : 'Control+Enter'}
                className="ml-auto inline-flex h-[34px] shrink-0 items-center gap-2 rounded-[7px] bg-accent px-4 text-[14px] font-medium text-panel hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {failed ? 'Retry' : 'Send'}
                <KeyChip primary>{submitKey}</KeyChip>
              </button>
            </div>
          </form>
        )}
      </div>
    </DialogBackdrop>
  )
}
