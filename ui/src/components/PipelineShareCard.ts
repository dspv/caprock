/**
 * The Pipeline's Flow figures as a picture to share (.ai/04-ui.md § Share,
 * "The Pipeline card"; owner, 2026-10-15, translated: "I want to share the
 * Pipeline figures sometimes").
 *
 * The eight figures the page shows, each with its 14-day line, the stretch
 * they cover and caprock.dev, drawn on a canvas in the browser at 2x — nothing
 * uploaded to draw it.
 *
 * **Anonymous unless asked** (owner, the same day: anonymisation is a must).
 * A repository's name can be private, and a share card travels further than
 * whoever posted it meant. So the card and every word that goes with it say
 * "a GitHub repo" and carry only aggregates: no pull request titles, branch
 * names, authors, avatars, release names, paths or session titles — nothing
 * here even reads them; the card is built from `board.flow` and the name
 * alone. The name appears only when the person ticks Show repo name for that
 * one share, and the tick is never remembered, so a private name cannot leak
 * by habit. "A GitHub repo", not "a private repo": Caprock does not know the
 * repository's visibility, and calling a public one private would be untrue.
 */
import type { PRBoard, SeriesKey } from '@/lib/prboard'
import { flowFigures } from './PRBoard'
import { drawBrand, fontsReady, MONO, PALETTE, SANS, type CardLook } from './ShareCard'

/** What the card says in place of the name until Show repo name is ticked. */
export const ANON_REPO = 'a GitHub repo'

/** The card's logical size; the file is twice that. */
export const PIPE_W = 1200
export const PIPE_H = 630
export const PIPE_SCALE = 2

/** One figure as the card draws it. */
export interface PipeFigure {
  key: string
  label: string
  value: string
  sub: string
  tone?: 'ok' | 'danger'
  /** The days' values, oldest first; a missing day is a gap. */
  series?: (number | undefined)[]
}

/** Everything the card shows — and, by construction, nothing else. */
export interface PipeCardData {
  /** The repository as the card names it: owner/name, or ANON_REPO. */
  repo: string
  days: number
  takenAt: Date
  figures: PipeFigure[]
}

/** The repository as a share names it. */
export function repoLabel(repo: string | undefined, show: boolean): string {
  return show && repo ? repo : ANON_REPO
}

/** The card's figures, from the board's flow only: the page's eight, as shown. */
export function pipelineCardData(board: PRBoard, repo: string | undefined, show: boolean, takenAt = new Date()): PipeCardData {
  const figures = flowFigures(board).map((f): PipeFigure => {
    const pts = f.series ? board.flow.series?.[f.series as SeriesKey] : undefined
    return {
      key: f.key,
      // The cost tile says what its figure is on the card itself: a dollar
      // figure posted without "list price" reads as a bill.
      label: f.key === 'cost' ? 'Agent cost' : f.label,
      value: f.value,
      sub: f.key === 'cost' ? 'at API list price — not a bill' : typeof f.sub === 'string' ? f.sub : '',
      tone: f.tone,
      series: pts && pts.length > 1 ? pts.map((p) => p.value) : undefined,
    }
  })
  return { repo: repoLabel(repo, show), days: board.flow.days, takenAt, figures }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "2 Oct – 15 Oct 2026": the window the figures cover, ending the day drawn. */
export function pipeRange(d: Pick<PipeCardData, 'days' | 'takenAt'>): string {
  const end = d.takenAt
  const start = new Date(end)
  start.setDate(end.getDate() - Math.max(0, d.days - 1))
  const fmt = (x: Date, year: boolean) => `${x.getDate()} ${MONTHS[x.getMonth()]}${year ? ` ${x.getFullYear()}` : ''}`
  return `${fmt(start, start.getFullYear() !== end.getFullYear())} – ${fmt(end, true)}`
}

/**
 * The words that go with the card — the post, the Telegram caption: the
 * repository as the card names it and three figures that have a value, then
 * the site. Editable in the sheet; this is only its first draft.
 */
export function pipelinePostText(d: PipeCardData): string {
  const by = new Map(d.figures.map((f) => [f.key, f]))
  const has = (k: string) => { const v = by.get(k)?.value; return v && v !== '–' ? v : '' }
  const bits: string[] = []
  if (has('throughput')) bits.push(`${has('throughput').replace('/day', ' PRs/day')}`)
  if (has('ci')) bits.push(`CI median ${has('ci')}`)
  if (has('ttm')) bits.push(`opened → merged in ${has('ttm')}`)
  const when = d.days === 14 ? 'this fortnight' : `the last ${d.days} days`
  return `${d.repo} ${when}${bits.length ? `: ${bits.join(', ')}` : ''} — via caprock.dev`
}

/** Tones the tiles use, on each ground. */
const TONE: Record<CardLook, { ok: string; danger: string }> = {
  dark: { ok: '#8fd19e', danger: '#f0937a' },
  paper: { ok: '#2f6b3a', danger: '#a3361c' },
}

/** A minimal 2D context: what the painter calls, so a test can read every word drawn. */
export type Paint = Pick<CanvasRenderingContext2D, 'fillRect' | 'fillText' | 'measureText' | 'beginPath' | 'moveTo' | 'lineTo' | 'closePath' | 'stroke'>
  & Partial<Pick<CanvasRenderingContext2D, 'save' | 'restore' | 'scale' | 'arc' | 'fill' | 'roundRect' | 'setLineDash'>>
  & { font: string; fillStyle: CanvasRenderingContext2D['fillStyle']; strokeStyle: CanvasRenderingContext2D['strokeStyle']; lineWidth: number; lineJoin: CanvasLineJoin; textAlign: CanvasTextAlign }

/** Paint the card at its logical size; the caller has scaled the context. */
export function paintPipelineCard(g: Paint, d: PipeCardData, look: CardLook): void {
  const p = PALETTE[look]
  const tone = TONE[look]
  const W = PIPE_W
  const H = PIPE_H
  const pad = 56
  g.fillStyle = p.bg
  g.fillRect(0, 0, W, H)

  const text = (x: number, y: number, s: string, font: string, fill: string, align: CanvasTextAlign = 'left') => {
    g.font = font
    g.fillStyle = fill
    g.textAlign = align
    g.fillText(s, x, y)
  }
  const width = (s: string, font: string) => { g.font = font; return g.measureText(s).width }
  /** Shortened with an ellipsis until it fits. */
  const fit = (s: string, font: string, max: number) => {
    if (width(s, font) <= max) return s
    let t = s
    while (t.length > 1 && width(`${t}…`, font) > max) t = t.slice(0, -1)
    return `${t}…`
  }

  // Top: the brand; opposite, what this is and the window.
  drawBrand(g as CanvasRenderingContext2D, pad, 70, look)
  const range = pipeRange(d).toUpperCase()
  const rf = `500 16px ${MONO}`
  text(W - pad, 68, range, rf, p.faint, 'right')
  const what = `PIPELINE · LAST ${d.days} DAYS`
  text(W - pad - width(range, rf) - 18, 68, what, `700 16px ${MONO}`, p.accent, 'right')

  // The repository as the card names it, and what the figures are of.
  const nf = `700 38px ${SANS}`
  text(pad, 140, fit(d.repo, nf, W - pad * 2), nf, p.ink)
  text(pad, 172, 'pull requests on their way to a release · read from GitHub', `500 18px ${SANS}`, p.muted)

  // The figures: four by two, each a tile with its line.
  const cols = 4
  const gap = 14
  const top = 200
  const tileW = (W - pad * 2 - gap * (cols - 1)) / cols
  const tileH = 168
  d.figures.slice(0, 8).forEach((f, i) => {
    const x = pad + (i % cols) * (tileW + gap)
    const y = top + Math.floor(i / cols) * (tileH + gap)
    g.fillStyle = p.raise
    if (g.roundRect) { g.beginPath(); g.roundRect(x, y, tileW, tileH, 10); g.fill?.() } else g.fillRect(x, y, tileW, tileH)
    const ix = x + 16
    text(ix, y + 30, fit(f.label.toUpperCase(), `600 13px ${MONO}`, tileW - 32), `600 13px ${MONO}`, p.muted)
    const vf = `700 36px ${MONO}`
    const fill = f.tone === 'danger' ? tone.danger : f.tone === 'ok' ? tone.ok : p.ink
    text(ix, y + 74, fit(f.value, vf, tileW - 32), vf, fill)
    text(ix, y + 98, fit(f.sub, `500 14px ${SANS}`, tileW - 32), `500 14px ${SANS}`, p.faint)
    if (f.series) sparkline(g, f.series, ix, y + 114, tileW - 32, 38, p.accent, p.line)
  })

  // The foot: how it was measured; the site opposite.
  const footY = H - 34
  text(pad, footY, 'measured locally · aggregate figures only · cost at API list price', `500 14px ${MONO}`, p.faint)
  text(W - pad, footY, 'caprock.dev', `700 20px ${MONO}`, p.accent, 'right')
  g.textAlign = 'left'
}

/** A figure's days as a line: gaps stay gaps, today a dot at the right end. */
function sparkline(g: Paint, pts: (number | undefined)[], x: number, y: number, w: number, h: number, ink: string, base: string) {
  const vals = pts.filter((v): v is number => v !== undefined)
  g.fillStyle = base
  g.fillRect(x, y + h, w, 1)
  if (vals.length === 0) return
  const hi = Math.max(...vals, 1e-9)
  const n = pts.length
  const px = (i: number) => x + (n <= 1 ? w / 2 : (i / (n - 1)) * w)
  const py = (v: number) => y + h - (v / hi) * (h - 4)
  g.strokeStyle = ink
  g.lineWidth = 2.2
  g.lineJoin = 'round'
  let drawing = false
  g.beginPath()
  pts.forEach((v, i) => {
    if (v === undefined) { drawing = false; return }
    if (drawing) g.lineTo(px(i), py(v))
    else { g.moveTo(px(i), py(v)); drawing = true }
  })
  g.stroke()
  // A day alone between gaps is a dot, as the page's line draws it; a
  // moveTo with nothing after it would draw nothing.
  if (g.arc) {
    g.fillStyle = ink
    pts.forEach((v, i) => {
      if (v === undefined || i === n - 1 || pts[i - 1] !== undefined || pts[i + 1] !== undefined) return
      g.beginPath()
      g.arc!(px(i), py(v), 2.2, 0, Math.PI * 2)
      g.fill?.()
    })
  }
  const last = pts[n - 1]
  if (last !== undefined && g.arc) {
    g.fillStyle = ink
    g.beginPath()
    g.arc(px(n - 1), py(last), 3.5, 0, Math.PI * 2)
    g.fill?.()
  }
}

/** Draw the card and hand back a 2x PNG; null where the browser cannot draw. */
export async function drawPipelineCard(d: PipeCardData, look: CardLook): Promise<Blob | null> {
  const c = document.createElement('canvas')
  c.width = PIPE_W * PIPE_SCALE
  c.height = PIPE_H * PIPE_SCALE
  let g: CanvasRenderingContext2D | null = null
  try { g = c.getContext('2d') } catch { return null }
  if (!g) return null
  await fontsReady()
  try {
    g.scale(PIPE_SCALE, PIPE_SCALE)
    paintPipelineCard(g, d, look)
  } catch {
    return null
  }
  return await new Promise<Blob | null>((resolve) => {
    if (typeof c.toBlob !== 'function') { resolve(null); return }
    c.toBlob((b) => resolve(b), 'image/png')
  })
}

/** The file's name: dated, and named for the repository only when it is shown. */
export function pipelineFilename(d: PipeCardData): string {
  const t = d.takenAt
  const two = (n: number) => String(n).padStart(2, '0')
  const who = d.repo === ANON_REPO ? '' : `${d.repo.replace(/[^A-Za-z0-9._-]+/g, '-')}-`
  return `caprock-pipeline-${who}${t.getFullYear()}-${two(t.getMonth() + 1)}-${two(t.getDate())}.png`
}
