/**
 * The feedback button, and the form behind it: what it is, a title, a few
 * words, screenshots — and out comes a GitHub issue the user submits.
 *
 * **The form.** Bug / Idea / Question as a segmented control (each maps to a
 * label that exists on the repo), a required title that becomes the issue's
 * title, an optional description, screenshots pasted (⌘V anywhere in the
 * dialog), dropped or chosen — up to four, a thumbnail each with a × — and a
 * one-line "Included: version, OS…" that opens to show exactly what the
 * diagnostics say, with a box to leave them out.
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
 * it (2026-10-10).
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
import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react'
import { api } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { openExternal } from '@/lib/nudges'
import { isAppMode, isMacPlatform } from '@/lib/appmode'
import { context, currentScreen, isSendable, issueURL, KINDS, type FeedbackKind } from '@/lib/feedback'
import { accept, baseName, copyImage, imageTypeOfPath, imagesIn, MAX_SHOTS, nextShot, stepLine, toPNG, type Shot } from '@/lib/attachments'
import { captureSupported, shell } from '@/lib/shell'
import { DROP_PATHS_EVENT } from '@/lib/xtermInput'
import { FeedbackIcon } from './AppIcons'
import { CloseButton, DialogBackdrop } from './Dialog'

const TIP = 'Report a bug, suggest an idea, or ask a question'

/**
 * `header`: the labelled button in the dashboard's header. `icon`: a 26px
 * icon button for the app sidebar's bottom bar. `screen` names where the
 * report comes from; without it, the screen in front when the dialog opens.
 */
export function FeedbackButton({ screen, variant = 'header' }: { screen?: string; variant?: 'header' | 'icon' }) {
  const [open, setOpen] = useState<string | null>(null)
  const show = () => setOpen(screen ?? currentScreen(location.hash, isAppMode()))
  return (
    <>
      {variant === 'icon' ? (
        <button
          type="button"
          onClick={show}
          title={`Feedback: ${TIP.toLowerCase()}`}
          aria-label="Send feedback"
          className="flex h-[26px] w-[26px] items-center justify-center rounded-[6px] text-fg-muted transition-colors hover:bg-[var(--app-row-hover)] hover:text-fg motion-reduce:transition-none"
        >
          <FeedbackIcon size={15} />
        </button>
      ) : (
        <button
          type="button"
          onClick={show}
          title={TIP}
          className="inline-flex h-[24px] items-center gap-1.5 rounded-[6px] border border-border-strong bg-panel-2/60 px-2 text-[12px] font-medium text-fg transition-colors hover:border-accent/60 hover:text-accent motion-reduce:transition-none"
        >
          <FeedbackIcon size={13} />
          Feedback
        </button>
      )}
      {open !== null && <FeedbackDialog screen={open} onClose={() => setOpen(null)} />}
    </>
  )
}

let shotSeq = 0

function FeedbackDialog({ screen, onClose }: { screen: string; onClose: () => void }) {
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
        className={`w-full max-w-[560px] border bg-panel rounded-[var(--radius-panel)] shadow-lg ${
          dragging ? 'border-accent' : 'border-border-strong'
        }`}
      >
        <div className="pl-4 pr-2 py-1.5 border-b border-border flex items-center">
          <span className="text-[15px] font-medium">{step ? 'Attach your screenshots' : 'Send feedback'}</span>
          <CloseButton onClick={onClose} className="ml-auto" />
        </div>

        {step ? (
          <div className="p-4 grid gap-3">
            <p className="text-[13px] leading-relaxed" role="status">
              {stepLine(step.i, shots.length, step.copied, pasteKey, !!step.saved)}
            </p>
            <div className="flex gap-2">
              {shots.map((s, i) => (
                <img
                  key={s.id}
                  src={s.url}
                  alt={`Screenshot ${i + 1}`}
                  className={`h-14 w-20 rounded-[5px] border object-cover ${
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
                  className="rounded-[6px] border border-border-strong px-3 py-1 text-[12.5px] text-fg hover:border-accent/60 hover:text-accent"
                >
                  Copy next ({nextShot(step.i, shots.length) + 1} of {shots.length})
                </button>
              )}
              {!step.copied && (
                <button
                  type="button"
                  onClick={saveAll}
                  className="rounded-[6px] border border-border-strong px-3 py-1 text-[12.5px] text-fg hover:border-accent/60 hover:text-accent"
                >
                  {step.saved ? 'Saved — save again' : shots.length > 1 ? 'Save screenshots' : 'Save screenshot'}
                </button>
              )}
              <button
                type="button"
                onClick={onClose}
                className="ml-auto rounded-[6px] bg-accent px-3.5 py-1 text-[12.5px] font-medium text-panel hover:brightness-110"
              >
                Done
              </button>
            </div>
            <p className="text-[11px] text-fg-faint leading-relaxed">
              The issue is open in your browser. GitHub uploads what you paste
              there; Caprock sends nothing.
            </p>
          </div>
        ) : (
          <form
            className="p-4 grid gap-3"
            onSubmit={(e) => { e.preventDefault(); send() }}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); send() }
            }}
          >
            <div className="inline-flex w-fit items-center gap-0.5 rounded-md bg-panel-2 p-0.5" role="radiogroup" aria-label="What is it">
              {KINDS.map((k) => (
                <button
                  key={k.id}
                  type="button"
                  role="radio"
                  aria-checked={k.id === kind}
                  onClick={() => setKind(k.id)}
                  className={`px-3 py-1 rounded-[5px] text-[12.5px] ${
                    k.id === kind ? 'bg-accent text-panel font-medium' : 'text-fg-muted hover:text-fg'
                  }`}
                >
                  {k.label}
                </button>
              ))}
            </div>

            <label className="grid gap-1">
              <span className="text-[11px] text-fg-muted">Title</span>
              {/* Autofocused: the fewer deliberate actions between "I noticed
                * something" and typing it, the more reports get written.
                * Prose, so the sans face: `.input` sets mono outside any
                * layer, where a font utility cannot reach it. */}
              <input
                autoFocus
                value={titleText}
                onChange={(e) => setTitleText(e.target.value)}
                placeholder={active.title}
                maxLength={256}
                className="input w-full text-[14px] py-1.5"
                style={{ fontFamily: 'var(--font-sans)' }}
              />
            </label>

            <label className="grid gap-1">
              <span className="text-[11px] text-fg-muted">Description <span className="text-fg-faint">— optional</span></span>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={active.hint}
                rows={4}
                className="input w-full resize-y text-[13.5px] leading-relaxed"
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
                      className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-border-strong bg-panel text-[12px] leading-none text-fg-muted hover:text-fg"
                    >
                      ×
                    </button>
                  </div>
                ))}
                {shots.length < MAX_SHOTS && (
                  <button
                    type="button"
                    onClick={() => picker.current?.click()}
                    className={`flex h-14 items-center gap-1.5 rounded-[5px] border border-dashed px-3 text-[12px] ${
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
                    className="flex h-14 shrink-0 items-center justify-center rounded-[5px] border border-dashed border-border-strong px-3 text-[12px] text-fg-muted hover:text-fg hover:border-fg-muted"
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
              {note && <p className="text-[11.5px] text-warn" role="status">{note}</p>}
            </div>

            <div className="text-[11.5px] text-fg-muted">
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
                <ul className="mt-1.5 ml-5 grid gap-0.5 text-[11px] text-fg-faint num">
                  {ctx.map((c) => <li key={c}>{c}</li>)}
                </ul>
              )}
            </div>

            <div className="flex items-center gap-3 border-t border-border pt-3">
              <span className="text-[11px] text-fg-faint leading-snug">
                Opens a prefilled issue in your browser. Nothing is sent from here.
              </span>
              <button
                type="submit"
                disabled={!ready}
                title={isMac ? '⌘↩' : 'Ctrl+↵'}
                className="ml-auto shrink-0 rounded-[6px] bg-accent px-3.5 py-1.5 text-[12.5px] font-medium text-panel hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Create issue
              </button>
            </div>
          </form>
        )}
      </div>
    </DialogBackdrop>
  )
}
