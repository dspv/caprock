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
      <button
        onClick={() => setOpen(true)}
        className="text-fg-muted hover:text-fg"
        title="Share your figures"
      >
        share
      </button>
      {open && <ShareDialog onClose={() => setOpen(false)} />}
    </>
  )
}

function ShareDialog({ onClose }: { onClose: () => void }) {
  const [busy, setBusy] = useState(false)
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
    setBusy(true); setNote('')
    try {
      const { blob, text } = await build()
      if (!blob) { setNote('Could not draw the card in this browser.'); return }
      const file = new File([blob], cardFilename(), { type: 'image/png' })
      await navigator.share({ files: [file], text })
      onClose()
    } catch (e) {
      // A cancelled share sheet is not an error worth reporting.
      if ((e as Error)?.name !== 'AbortError') setNote('Sharing was not available — the card was not sent.')
    } finally { setBusy(false) }
  }

  /** The fallback: save the image, open the site with the words ready. */
  const shareVia = async (to: 'x' | 'linkedin' | 'download') => {
    setBusy(true); setNote('')
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
    } finally { setBusy(false) }
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
      <div className="w-[440px] max-w-full rounded-[var(--radius-panel)] border border-border-strong bg-panel" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center border-b border-border px-4 py-3">
          <h2 className="text-[13px] font-medium text-fg">Share your figures</h2>
          <button onClick={onClose} className="ml-auto text-fg-muted hover:text-fg" aria-label="Close">✕</button>
        </header>

        <div className="px-4 py-3 text-[13px]">
          {/* Said before anything happens, not in a footnote afterwards. */}
          <p className="mt-3 text-[12px] leading-relaxed text-fg-muted">
            A card of the totals — cost, sessions, turns — carrying{' '}
            <span className="mono text-fg">caprock.dev</span>.{' '}
            <span className="text-fg-faint">
              No project names, no paths, no prose. Drawn on your machine; nothing is uploaded.
            </span>
          </p>

          <div className="mt-4 grid gap-2">
            {canNative ? (
              <button onClick={shareNative} disabled={busy}
                className="rounded-sm border border-accent bg-accent/15 px-3 py-1.5 text-accent hover:bg-accent/25 disabled:opacity-50">
                {busy ? 'preparing…' : 'Share…'}
              </button>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <button onClick={() => shareVia('x')} disabled={busy}
                  className="rounded-sm border border-accent bg-accent/15 px-3 py-1.5 text-accent hover:bg-accent/25 disabled:opacity-50">
                  Post on X
                </button>
                <button onClick={() => shareVia('linkedin')} disabled={busy}
                  className="rounded-sm border border-border px-3 py-1.5 text-fg-muted hover:border-border-strong hover:text-fg disabled:opacity-50">
                  Post on LinkedIn
                </button>
              </div>
            )}
            <button onClick={() => shareVia('download')} disabled={busy}
              className="rounded-sm border border-border px-3 py-1.5 text-[12px] text-fg-muted hover:border-border-strong hover:text-fg disabled:opacity-50">
              Just save the image
            </button>
          </div>

          {/* The honest part: a browser cannot attach a picture to a post. */}
          {!canNative && (
            <p className="mt-3 text-[11px] leading-relaxed text-fg-faint">
              X and LinkedIn cannot be handed an image by a link, so the card is saved
              and the post opens with the text written — drag the image in.
            </p>
          )}
          {note && <p className="mt-3 text-[12px] text-fg-muted">{note}</p>}
        </div>
      </div>
    </div>
  )
}
