/**
 * A picture of your own numbers, drawn locally and saved to disk.
 *
 * The figures are the most persuasive thing this product has, and they are
 * stuck inside one machine — this is the only feature here that works as both
 * a thing to use and a thing that travels. Nothing is uploaded: the card is
 * drawn on a canvas in the browser and downloaded, so what happens to it after
 * that is the user's decision, not ours.
 *
 * Deliberately no project names on it. A share button that quietly publishes
 * which repositories someone works on is a trap, and the figures alone are the
 * interesting part anyway.
 */
import { useRef, useState } from 'react'
import { api } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { fmtUSD } from '@/lib/format'

const W = 1200
const H = 630

/** Reads a design token, so the card matches whichever theme is on screen. */
function token(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

export function ShareCard() {
  const h = useApi(() => api.history('all'), [], { intervalMs: 60000 })
  const [done, setDone] = useState(false)
  const canvas = useRef<HTMLCanvasElement | null>(null)
  const t = h.data?.totals
  if (!t || t.sessions === 0) return null

  // No multiple here. It needs the window's calendar span to divide a monthly
  // fee by, and this endpoint reports active days only — dividing by those
  // priced 59 days of plan against 95 days of usage and printed 27.6× where
  // every other surface says 17.1×. A figure that cannot be checked does not
  // belong on an image someone posts; the cache line below is measured
  // directly and needs no denominator.

  const draw = () => {
    const c = canvas.current
    if (!c) return
    const g = c.getContext('2d')
    if (!g) return

    const bg = token('--color-bg', '#1b1b1a')
    const fg = token('--color-fg', '#e8e6e2')
    const muted = token('--color-fg-muted', '#a9a59e')
    const faint = token('--color-fg-faint', '#837f78')
    const accent = token('--color-accent', '#feb157')

    g.fillStyle = bg
    g.fillRect(0, 0, W, H)

    const mono = '"JetBrains Mono", ui-monospace, monospace'
    const sans = '"Hanken Grotesk", ui-sans-serif, system-ui, sans-serif'

    g.fillStyle = faint
    g.font = `500 22px ${mono}`
    g.fillText('CLAUDE CODE · MEASURED ON ONE MACHINE', 72, 92)

    // The headline: what the usage would have cost at API list prices.
    g.fillStyle = accent
    g.font = `600 132px ${sans}`
    g.fillText(fmtUSD(t.cost_usd), 72, 232)

    g.fillStyle = muted
    g.font = `400 30px ${sans}`
    g.fillText('of Claude Code at API list prices', 72, 286)

    // The three figures that give the headline a scale.
    const cells: [string, string][] = [
      [t.days.toLocaleString('en-US'), 'active days'],
      [t.sessions.toLocaleString('en-US'), 'sessions'],
      [t.turns.toLocaleString('en-US'), 'turns'],
    ]
    cells.forEach(([value, label], i) => {
      const x = 72 + i * 250
      g.fillStyle = fg
      g.font = `600 54px ${sans}`
      g.fillText(value, x, 400)
      g.fillStyle = faint
      g.font = `400 24px ${sans}`
      g.fillText(label, x, 434)
    })

    // Rule 6 travels with the figure: on a flat plan this is what the same
    // work would have cost per token, and a card without that line is a card
    // claiming a saving nobody made.
    g.fillStyle = muted
    g.font = `400 26px ${sans}`
    g.fillText('What this work would have cost through the API.', 72, 504)
    g.fillStyle = faint
    g.font = `400 21px ${sans}`
    g.fillText('Not a bill, and not money saved — priced from captured tokens.', 72, 540)

    g.fillStyle = faint
    g.font = `500 24px ${mono}`
    g.fillText('caprock.dev', 72, H - 48)

    c.toBlob((blob) => {
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'caprock.png'
      a.click()
      URL.revokeObjectURL(url)
      setDone(true)
      window.setTimeout(() => setDone(false), 2500)
    }, 'image/png')
  }

  return (
    <>
      <button
        onClick={draw}
        className="rounded-sm border border-border px-1.5 py-0.5 text-[11px] text-fg-muted hover:border-border-strong hover:text-fg"
        title="Draw a shareable image of these figures. Nothing is uploaded — it saves to your downloads."
      >
        {done ? 'saved ✓' : 'share these numbers'}
      </button>
      <canvas ref={canvas} width={W} height={H} className="hidden" />
    </>
  )
}
