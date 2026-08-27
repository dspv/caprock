/**
 * Share these numbers — from anywhere, in one click.
 *
 * The card could only be drawn from one panel on one screen, and drawing it
 * only saved a PNG: posting it meant finding the file, opening a social site
 * and writing the words yourself. Three steps, two of them chores.
 *
 * What a browser can actually do about that is limited, and the limit shapes
 * this component:
 *
 *  - **Web Share API** (`navigator.share` with `files`) hands the image
 *    straight to the operating system's share sheet — the real thing, on a
 *    phone and on recent desktop Safari. When it exists, that is the whole
 *    interaction: one click, pick an app, done.
 *  - **Everywhere else** a social site cannot be handed an image by URL; no
 *    amount of query string will attach a picture to a tweet. So the fallback
 *    downloads the card and opens the site with the text already written,
 *    leaving one drag to do. Saying that out loud beats a button that appears
 *    to post and does not.
 *
 * The card itself carries `caprock.dev`, so the link travels with the image
 * even when someone posts it without the text.
 */
import { useState } from 'react'
import { useApi } from '@/lib/useApi'
import { api, type History } from '@/lib/api'
import { cardFilename, collectCardData, drawShareCard } from './ShareCard'
import { fmtUSD } from '@/lib/format'

/** The words that travel with the image. Measured figures, no adjectives. */
function caption(t: History['totals']): string {
  const span = `over ${t.days} active days`
  return `${fmtUSD(t.cost_usd)} of Claude Code ${span}, across ${t.sessions.toLocaleString('en-US')} sessions — measured on my own machine with Caprock. https://caprock.dev`
}

export function ShareButton() {
  const [open, setOpen] = useState(false)
  return (
    <>
      {/* Loud on purpose. As grey 11px lowercase text between "feedback" and
        * the build label, this was invisible — the owner, who wrote the
        * feature, could not find it on his own dashboard. Sharing is the one
        * thing here that travels, so it gets a border and the accent colour
        * rather than the muted tone every other topbar item wears. */}
      <button
        onClick={() => setOpen(true)}
        className="rounded-md border border-accent/45 bg-accent/[0.08] px-2 py-0.5 text-accent hover:bg-accent/[0.16]"
        title="Draw a shareable image of your figures"
      >
        Share
      </button>
      {open && <ShareDialog onClose={() => setOpen(false)} />}
    </>
  )
}

export function ShareDialog({ onClose }: { onClose: () => void }) {
  // Two separate things, and conflating them produced two cards.
  //
  // `drawing` is "the card is being made" — that is what the label reports,
  // and it ends when the PNG exists. `locked` is "this dialog has already
  // started something" — it must outlast the label, because the OS share
  // sheet stays open long after the drawing is done. When one flag did both,
  // clearing it to fix the stuck "preparing…" also re-enabled the button
  // underneath the open share sheet, and a second click drew a second card.
  const [drawing, setDrawing] = useState(false)
  const [locked, setLocked] = useState(false)
  const [note, setNote] = useState('')

  const build = async () => {
    // No period to choose any more: the card shows today, the week, the month
    // and all time at once, which is what made the picker redundant rather
    // than a feature worth keeping.
    const [d, h] = await Promise.all([collectCardData(), api.history('all')])
    const blob = await drawShareCard(d)
    return { blob, text: caption(h.totals) }
  }

  /** The good path: hand the file to the OS and let it offer every app. */
  const shareNative = async () => {
    if (locked) return
    setLocked(true); setDrawing(true); setNote('')
    try {
      const { blob } = await build()
      if (!blob) { setNote('Could not draw the card in this browser.'); setLocked(false); return }
      const file = new File([blob], cardFilename(), { type: 'image/png' })
      // The label stops saying "drawing" here, because the drawing is done.
      // The button stays disabled, because the share sheet is about to open
      // and pressing again behind it would draw a second card.
      setDrawing(false)
      // The file travels alone.
      //
      // Sending `{files, text}` together looks like a courtesy — the picture
      // plus a caption to paste with it — but the receiving app decides what
      // to do with two payloads, and several of them treat it as two items:
      // the owner pressed Copy in the macOS share sheet and got the card
      // twice. The card already carries every figure and the caveat, so the
      // caption was never load-bearing; the image is the share.
      await navigator.share({ files: [file] })
      onClose()
    } catch (e) {
      // A cancelled share sheet is not an error worth reporting — but it does
      // hand the dialog back, so the buttons have to work again.
      if ((e as Error)?.name !== 'AbortError') setNote('Sharing was not available — the card was not sent.')
      setLocked(false)
    } finally { setDrawing(false) }
  }

  /** The fallback: save the image, open the site with the words ready. */
  const shareVia = async (to: 'x' | 'linkedin' | 'download') => {
    if (locked) return
    setLocked(true); setDrawing(true); setNote('')
    try {
      const { blob, text } = await build()
      if (!blob) { setNote('Could not draw the card in this browser.'); return }
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = cardFilename()
      a.click()
      URL.revokeObjectURL(url)
      if (to === 'download') { setNote('Saved to your downloads.'); return }
      const href = to === 'x'
        ? `https://x.com/intent/tweet?text=${encodeURIComponent(text)}`
        : `https://www.linkedin.com/feed/?shareActive=true&text=${encodeURIComponent(text)}`
      window.open(href, '_blank', 'noopener')
      setNote('Card saved and the post opened — drag the image in.')
    } finally { setDrawing(false); setLocked(false) }
  }

  const canNative = typeof navigator !== 'undefined' && typeof navigator.canShare === 'function'
    && navigator.canShare({ files: [new File([], 'x.png', { type: 'image/png' })] })

  return (
    <div
      className="fixed inset-0 z-30 flex items-start justify-center bg-black/50 px-4 pt-[14vh]"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Share your figures"
    >
      <div className="w-[420px] max-w-full rounded-[var(--radius-panel)] border border-border-strong bg-panel" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center border-b border-border px-4 py-3">
          <h2 className="text-[13px] font-medium text-fg">Share your figures</h2>
          <button onClick={onClose} className="ml-auto text-fg-muted hover:text-fg" aria-label="Close">✕</button>
        </header>

        <div className="px-4 py-4">
          {/* Two buttons, and each says where the picture goes.
            *
            * This was three paragraphs of 12px caveats above a button labelled
            * "Share…" — and the owner, who commissioned the feature, could not
            * tell what it did. An ellipsis is not a destination. The caveats
            * were all true and none of them was the question a person has
            * standing in front of this dialog, which is: what happens if I
            * press it. */}
          <div className="grid gap-2.5">
            {canNative && (
              <button
                onClick={shareNative}
                disabled={locked}
                className="rounded-md border border-accent bg-accent/15 px-4 py-3 text-[14px] font-medium text-accent hover:bg-accent/25 disabled:opacity-50"
              >
                {drawing ? 'Drawing the card…' : 'Send it somewhere'}
                <span className="mt-0.5 block text-[12px] font-normal text-fg-muted">
                  Opens your share menu — Messages, Mail, anywhere
                </span>
              </button>
            )}
            {/* Hover is a fill, not a border shade.
              *
              * This changed only its border colour, one step of grey against a
              * dark panel — the owner hovered it and could not tell anything
              * had happened. A control the eye cannot confirm it is pointing
              * at reads as disabled. */}
            <button
              onClick={() => shareVia('download')}
              disabled={locked}
              className="rounded-md border border-border bg-transparent px-4 py-3 text-[14px] text-fg transition-colors hover:border-border-strong hover:bg-panel-2 disabled:opacity-50"
            >
              {drawing && !canNative ? 'Drawing the card…' : 'Save the image'}
              <span className="mt-0.5 block text-[12px] text-fg-muted">
                A PNG in your downloads, to post wherever you like
              </span>
            </button>
          </div>

          {/* Two bullets, not a paragraph.
            *
            * This was two sentences of 12px grey prose, and prose is the wrong
            * shape for a list of guarantees: the reader is scanning for what
            * does and does not leave the machine, and a sentence makes them
            * read it to find out. Bigger, and one claim per line. */}
          <ul className="mt-4 grid gap-1 text-[13px] text-fg-muted">
            <li>Totals only — no names, no paths, nothing Claude wrote.</li>
            <li>Drawn on your machine. Uploaded nowhere.</li>
          </ul>
          {note && <p className="mt-2 text-[12px] text-fg-muted">{note}</p>}
        </div>
      </div>
    </div>
  )
}

export function ShareCard() {
  const h = useApi(() => api.history('all'), [], { intervalMs: 60000 })
  const [open, setOpen] = useState(false)
  const t = h.data?.totals
  if (!t || t.sessions === 0) return null

  return (
    <>
      {/* Opens the dialog rather than downloading on the spot.
        *
        * It used to draw and save immediately: four API calls, about a second
        * of nothing, then a file in Downloads with no explanation. The owner
        * reported it as "saves slowly and it is unclear what is happening",
        * which is exactly what a silent second followed by a silent file is.
        *
        * The dialog is where the two options live and where the work is
        * announced while it happens. */}
      <button
        onClick={() => setOpen(true)}
        className="rounded-md border border-accent/45 bg-accent/[0.08] px-2.5 py-1 text-[12px] text-accent hover:bg-accent/[0.16]"
        title="Draw a shareable image of these figures"
      >
        Share these numbers
      </button>
      {open && <ShareDialog onClose={() => setOpen(false)} />}
    </>
  )
}
