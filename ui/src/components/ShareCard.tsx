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
import { useEffect, useRef, useState } from 'react'
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

/**
 * The last round number this machine has passed, if it passed it recently.
 *
 * People share milestones, not arbitrary Tuesdays. "Just crossed $10,000" is a
 * thing someone posts; "$10,847.31" is not. Recent means within a tenth of the
 * step — cross $10,000 and it is worth mentioning for a while, but by $12,000
 * the moment has gone and a button still shouting about it is noise.
 */
function milestone(cost: number): number | null {
  const steps = [1000, 5000, 10_000, 25_000, 50_000, 100_000]
  const passed = steps.filter((v) => cost >= v).pop()
  if (!passed) return null
  return cost - passed <= passed * 0.1 ? passed : null
}

/** What a card is about. `all` is the lifetime figure; the others are periods. */
export type SharePeriod = 'all' | '7d' | '30d'

/** Everything a card shows. Gathered by the caller, drawn here. */
export interface CardData {
  /** When the card was drawn. A figure in a feed weeks later needs a date. */
  takenAt: Date
  today: { cost: number; sessions: number }
  week: { cost: number; sessions: number }
  month: { cost: number; tokens: number }
  allTime: { cost: number; days: number; tokens: number }
  cacheHitPct: number
  /** Top models by cost, and top kinds of work. Both already sorted. */
  models: { label: string; cost: number }[]
  work: { label: string; cost: number }[]
}

const WORK_LABEL: Record<string, string> = {
  command: 'running commands',
  edit: 'writing code',
  read: 'reading code',
  mcp: 'MCP tools',
  web: 'web research',
  other: 'other tools',
  none: 'no tool call',
}

/**
 * Model ids are long and the panel is narrow; the vendor prefix says nothing.
 *
 * The slash matters more than the length. A gateway reports
 * `minimax/minimax-m3`, and a slash on a card someone is about to post is
 * indistinguishable from a repository path to whoever reads it — so the
 * vendor half goes before anything else.
 */
function shortModel(id: string): string {
  return id
    .slice(id.lastIndexOf('/') + 1)
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '')
    .slice(0, 18)
}

function shortTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${Math.round(n / 1e6)}M`
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`
  return String(n)
}

/**
 * The card, as agreed: eight tiles over two breakdowns.
 *
 * It is drawn to look like the dashboard rather than like an advert, because
 * what people actually share is a screenshot of the thing working. A poster
 * with one huge number on it reads as marketing and gets scrolled past; a
 * panel someone recognises as a real screen gets looked at.
 *
 * Every figure is measured. Deliberately absent: the instantaneous burn rate,
 * which read $7.33 one minute and $33.54 the next — a card that lives in a
 * feed for weeks must not carry a number that was true for ninety seconds.
 */
function paintCard(g: CanvasRenderingContext2D, d: CardData) {
  const bg = token('--color-bg', '#141414')
  const panelBg = token('--color-panel', '#1a1a19')
  const line = token('--color-border', '#2a2a28')
  const fg = token('--color-fg', '#e8e6e2')
  const muted = token('--color-fg-muted', '#a9a59e')
  const faint = token('--color-fg-faint', '#6f6b64')
  const accent = token('--color-accent', '#feb157')
  const ok = token('--color-ok', '#7fc99a')

  const mono = '"JetBrains Mono", ui-monospace, monospace'
  const sans = '"Hanken Grotesk", ui-sans-serif, system-ui, sans-serif'

  g.fillStyle = bg
  g.fillRect(0, 0, W, H)

  const roundRect = (x: number, y: number, w: number, h: number, r = 12) => {
    g.beginPath()
    g.moveTo(x + r, y)
    g.arcTo(x + w, y, x + w, y + h, r)
    g.arcTo(x + w, y + h, x, y + h, r)
    g.arcTo(x, y + h, x, y, r)
    g.arcTo(x, y, x + w, y, r)
    g.closePath()
  }
  const panel = (x: number, y: number, w: number, h: number) => {
    roundRect(x, y, w, h)
    g.fillStyle = panelBg
    g.fill()
    g.strokeStyle = line
    g.lineWidth = 1
    g.stroke()
  }
  const text = (x: number, y: number, s: string, size: number, fill: string,
                font = sans, weight = 400, align: CanvasTextAlign = 'left') => {
    g.fillStyle = fill
    g.font = `${weight} ${size}px ${font}`
    g.textAlign = align
    g.fillText(s, x, y)
  }

  text(64, 78, 'My stats on caprock.dev', 32, fg, sans, 600)
  // Beside the heading rather than in the footer: a reader deciding whether
  // these numbers are current should not have to hunt for the date.
  text(1136, 78, d.takenAt.toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
  }), 15, faint, mono, 400, 'right')

  const tiles: [string, string, string, string][] = [
    ['TODAY', fmtUSD(d.today.cost), `${d.today.sessions} sessions`, accent],
    ['THIS WEEK', fmtUSD(d.week.cost), `${d.week.sessions} sessions`, fg],
    ['THIS MONTH', fmtUSD(d.month.cost), `${shortTokens(d.month.tokens)} tokens`, fg],
    ['ALL TIME', fmtUSD(d.allTime.cost), `${d.allTime.days} active days`, accent],
    ['A DAY', fmtUSD(d.allTime.cost / Math.max(1, d.allTime.days)), 'on average', fg],
    ['TOKENS', shortTokens(d.allTime.tokens), 'all time', fg],
    // The one tile that answers "dear or cheap" rather than "how much".
    ['PER 1M TOKENS', fmtUSD(d.allTime.cost / Math.max(1, d.allTime.tokens / 1e6)),
      'what a million costs', fg],
    ['CACHE HIT', `${Math.round(d.cacheHitPct)}%`, 'input cost cut', ok],
  ]
  tiles.forEach(([label, value, sub, colour], i) => {
    const x = 64 + (i % 4) * 272
    const y = 130 + Math.floor(i / 4) * 114
    panel(x, y, 256, 98)
    text(x + 20, y + 30, label, 13, faint, mono)
    text(x + 20, y + 56, value, 28, colour, sans, 600)
    text(x + 20, y + 81, sub, 14, muted)
  })

  const bars = (x: number, y: number, rows: { label: string; cost: number }[], title: string) => {
    const width = 524
    const h = 44 + rows.length * 26 + 12
    panel(x, y, width, h)
    text(x + 20, y + 30, title, 13, faint, mono)
    const top = Math.max(...rows.map((r) => r.cost), 1)
    const sum = rows.reduce((a, r) => a + r.cost, 0)
    // Three columns: label, bar, then the money and its share. The bar is
    // shortened to make room for the percentage — a bar without one says
    // "this is the biggest" and nothing about how much bigger.
    const barX = x + 170
    const barW = width - 170 - 190
    rows.forEach((r, i) => {
      const yy = y + 62 + i * 26
      text(x + 20, yy, r.label, 14, muted, mono)
      g.fillStyle = accent
      g.globalAlpha = 0.85
      roundRect(barX, yy - 10, Math.max(2, barW * (r.cost / top)), 10, 3)
      g.fill()
      g.globalAlpha = 1
      text(x + width - 62, yy, fmtUSD(r.cost), 14, fg, mono, 400, 'right')
      // Floored, and never shown as 0% for a row that cost something: a
      // sliver that reads 0% looks like a bug rather than a small number.
      const pct = sum > 0 ? Math.max(1, Math.floor((100 * r.cost) / sum)) : 0
      text(x + width - 20, yy, `${pct}%`, 14, faint, mono, 400, 'right')
    })
    return h
  }

  const h = bars(64, 372, d.models, 'WHERE THE MONEY WENT')
  bars(612, 372, d.work, 'WHAT IT WENT ON')

  const footY = 372 + h + 34
  text(64, footY, 'caprock.dev', 16, accent, mono, 600)
  // The full caveat, not the short one. A dollar figure posted without it
  // reads as a bill somebody paid, and "not money saved" is the half that
  // stops a flat-plan reader thinking this is a discount they received.
  text(1136, footY, 'at API list prices — not a bill, and not money saved', 14, faint, sans, 400, 'right')
  g.textAlign = 'left'
}

/**
 * What the file is called when it lands in someone's downloads.
 *
 * Dated, because a person who draws one of these more than once ends up with
 * `caprock.png`, `caprock (1).png`, `caprock (2).png` and no way to tell which
 * month is which — and the card itself carries a date, so the file disagreeing
 * with its contents is worse than no date at all.
 */
export function cardFilename(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `caprock-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.png`
}

/** Gather what the card needs. Four ranges, because the card shows four. */
export async function collectCardData(): Promise<CardData> {
  const [today, week, month, hist] = await Promise.all([
    api.summary('today'),
    api.summary('7d'),
    api.summary('30d'),
    api.history('all'),
  ])
  const toks = (s: { tokens_in: number; tokens_out: number; cache_read: number; cache_write: number }) =>
    s.tokens_in + s.tokens_out + s.cache_read + s.cache_write
  return {
    takenAt: new Date(),
    today: { cost: today.cost_usd, sessions: today.sessions },
    week: { cost: week.cost_usd, sessions: week.sessions },
    month: { cost: month.cost_usd, tokens: toks(month) },
    allTime: {
      cost: hist.totals.cost_usd,
      days: hist.totals.days,
      tokens: toks(hist.summary),
    },
    cacheHitPct: (month.savings?.hit_rate ?? 0) * 100,
    models: (month.models ?? []).slice(0, 5)
      .map((m) => ({ label: shortModel(m.model), cost: m.cost_usd })),
    work: (month.work ?? []).slice(0, 5)
      .map((w) => ({ label: WORK_LABEL[w.kind] ?? w.kind, cost: w.cost_usd })),
  }
}

/**
 * Draw the card and hand back a PNG, with no component around it.
 *
 * The drawing used to live inside ShareCard, bound to its refs and its
 * "saved" flash — so the only way to produce this image was to render that
 * button somewhere and click it. A share dialog that offers three periods and
 * a native share sheet needs the picture, not the button, so the picture is
 * its own function now.
 *
 * Returns null when the browser cannot draw (jsdom, and any headless context
 * without a canvas). Callers say so rather than failing silently.
 */
export async function drawShareCard(data: CardData): Promise<Blob | null> {
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  let g: CanvasRenderingContext2D | null = null
  try {
    g = c.getContext('2d')
  } catch {
    return null
  }
  if (!g) return null
  paintCard(g, data)
  return await new Promise<Blob | null>((resolve) => {
    if (typeof c.toBlob !== 'function') { resolve(null); return }
    c.toBlob((b) => resolve(b), 'image/png')
  })
}

export function ShareCard({ period = 'all' }: { period?: SharePeriod } = {}) {
  const h = useApi(() => api.history(period), [period], { intervalMs: 60000 })
  const [done, setDone] = useState(false)
  const canvas = useRef<HTMLCanvasElement | null>(null)
  // The "saved" flash clears itself 2.5s later. Left uncancelled it fires
  // after the component is gone — in a test, after the DOM it refers to has
  // been torn down, which surfaced as `window is not defined` in a file that
  // never mentions this component.
  const flash = useRef<number | undefined>(undefined)
  useEffect(() => () => { if (flash.current !== undefined) clearTimeout(flash.current) }, [])
  const t = h.data?.totals
  if (!t || t.sessions === 0) return null

  // A milestone is a lifetime fact. "You just passed $1,000" makes no sense
  // about one week, and a period card is offered on a rhythm rather than
  // because a number was crossed.
  const reached = period === 'all' ? milestone(t.cost_usd) : null

  // No multiple here. It needs the window's calendar span to divide a monthly
  // fee by, and this endpoint reports active days only — dividing by those
  // priced 59 days of plan against 95 days of usage and printed 27.6× where
  // every other surface says 17.1×. A figure that cannot be checked does not
  // belong on an image someone posts; the cache line below is measured
  // directly and needs no denominator.

  const draw = async () => {
    // One path to the picture: the dialog and this button draw the same card
    // from the same data, so they cannot drift into two designs.
    const blob = await drawShareCard(await collectCardData())
    if (!blob) return
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = cardFilename()
    a.click()
    URL.revokeObjectURL(url)
    setDone(true)
    flash.current = window.setTimeout(() => setDone(false), 2500)
  }

  return (
    <>
      {/* Louder for a while after a round number is crossed, quiet the rest of
        * the time. The button is always there; only its volume moves. */}
      <button
        onClick={draw}
        className={`rounded-sm border px-1.5 py-0.5 text-[11px] ${
          reached
            ? 'border-accent/50 bg-accent/10 text-accent hover:bg-accent/20'
            : 'border-border text-fg-muted hover:border-border-strong hover:text-fg'
        }`}
        title="Draw a shareable image of these figures. Nothing is uploaded — it saves to your downloads."
      >
        {done
          ? 'saved ✓'
          : reached
            ? `you just passed ${fmtUSD(reached)} — share it`
            : 'share these numbers'}
      </button>
      <canvas ref={canvas} width={W} height={H} className="hidden" />
    </>
  )
}
