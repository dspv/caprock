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
import { api } from '@/lib/api'
import { fmtUSD } from '@/lib/format'

const W = 1200
const H = 630

/** Reads a design token, so the card matches whichever theme is on screen. */
function token(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

/** What a card is about. `all` is the lifetime figure; the others are periods. */
/** Which stretch a card is about.
 *
 * The picker was removed once on the reasoning that a card showing today, the
 * week, the month and all time at once made choosing redundant. It does not:
 * somebody sharing a working week does not want their lifetime total to be the
 * headline, and a card that answers four questions answers none of them
 * loudly. The period decides what is said big; the other figures stay, because
 * the context is what makes a number mean anything. */
export type SharePeriod = 'today' | '7d' | '30d' | 'all'

/** What each period is called on the card, and which tile it makes the point. */
export const PERIOD_LABEL: Record<SharePeriod, string> = {
  today: 'today',
  '7d': 'this week',
  '30d': 'this month',
  all: 'all time',
}

/** Everything a card shows. Gathered by the caller, drawn here. */
export interface CardData {
  /** Which stretch this card is about. */
  period: SharePeriod
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

  // One heading, read left to right: whose, what, where, when.
  //
  // The domain and the date used to sit in opposite corners in small type, and
  // neither could be read at the size a card appears in a feed. Both belong on
  // the line someone actually looks at — and the domain is the only part that
  // has to survive a screenshot being reposted, so it is the only part in the
  // accent colour.
  //
  // Widths are measured rather than guessed: the fonts differ between themes
  // and platforms, and a hand-tuned offset is a gap that is right on one
  // machine and wrong on the next.
  const headSize = 32
  g.font = `600 ${headSize}px ${sans}`
  // No trailing space in the lead: measureText already returns the width up to
  // the last glyph, so a space there is a second gap on top of the measured
  // one — which is where the hole between "on" and the domain came from.
  // The heading names the stretch, so a card shared out of context still says
  // what it is about. "My week on caprock.dev" is a claim; "My stats on
  // caprock.dev" beside four periods is a shrug.
  const lead = d.period === 'all' ? 'My stats on' : `My ${PERIOD_LABEL[d.period].replace('this ', '')} on`
  const space = g.measureText(' ').width
  const leadW = g.measureText(lead).width
  text(64, 78, lead, headSize, fg, sans, 600)
  const domainX = 64 + leadW + space
  text(domainX, 78, 'caprock.dev', headSize, accent, sans, 600)
  const domainW = g.measureText('caprock.dev').width
  // The date is part of the heading, not a footnote to it: same weight, same
  // family, one size down so it reads as the tail of the sentence. An en dash,
  // because a hyphen between words is a typo and an em dash is a pause.
  const date = d.takenAt.toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
  })
  text(domainX + domainW + space * 2, 78, `– ${date}`, 26, faint, sans, 600)

  // The chosen period is the one in accent; the rest are context rather than
  // competition. Every figure stays on the card — a week means nothing without
  // knowing whether it was a normal one.
  const lit = (p: SharePeriod) => (d.period === p ? accent : fg)
  const tiles: [string, string, string, string][] = [
    ['TODAY', fmtUSD(d.today.cost), `${d.today.sessions} sessions`, lit('today')],
    ['THIS WEEK', fmtUSD(d.week.cost), `${d.week.sessions} sessions`, lit('7d')],
    ['THIS MONTH', fmtUSD(d.month.cost), `${shortTokens(d.month.tokens)} tokens`, lit('30d')],
    ['ALL TIME', fmtUSD(d.allTime.cost), `${d.allTime.days} active days`, lit('all')],
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
      // A corner radius wider than the bar itself draws a squiggle rather than
      // a bar: haiku at $0.59 is two pixels next to opus at $5,338, and the
      // 3px rounding turned it into a hook. Cap the radius at half the width.
      const w = Math.max(2, barW * (r.cost / top))
      roundRect(barX, yy - 10, w, 10, Math.min(3, w / 2))
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

  // The breakdowns are the chosen period's, so the headings need no qualifier
  // — except on an all-time card, where there is no all-time split to draw and
  // the month stands in for it. Saying which is cheaper than a chart that
  // quietly answers a different question from the one above it.
  const span = d.period === 'all' ? ' · LAST 30 DAYS' : ''
  const h = bars(64, 372, d.models, `WHERE THE MONEY WENT${span}`)
  bars(612, 372, d.work, `WHAT IT WENT ON${span}`)

  // The full caveat, not the short one. A dollar figure posted without it
  // reads as a bill somebody paid, and "not money saved" is the half that
  // stops a flat-plan reader thinking this is a discount they received.
  //
  // On the left, where a reader's eye returns — it was in the right corner
  // opposite a domain nobody could read either.
  const footY = 372 + h + 34
  text(64, footY, 'at API list prices — not a bill, and not money saved', 14, faint)

  // The invitation, opposite the caveat.
  //
  // The card carried a figure and a domain and stopped there: a reader saw
  // somebody else's $11,442 and had no reason to think it was a thing they
  // could do too. The loop this product grows by is see it → want yours →
  // install → post yours, and nothing on the card started it.
  //
  // A question rather than a command. "brew install …" on a picture is an
  // advertisement and reads as one; "What's yours?" is the thing a person
  // actually wonders when they see a number like this, said out loud. The
  // domain in the heading is where they go to find out.
  text(W - 64, footY, "What's yours?", 15, accent, sans, 600, 'right')
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

/**
 * Gather what the card needs.
 *
 * Four ranges because the four tiles are always drawn — a week means nothing
 * without knowing whether it was a normal one, which is why choosing a period
 * lights one tile rather than removing the others.
 *
 * The two breakdowns below them are a different matter: they belong to the
 * period the card is *about*. They used to come from the 30-day summary
 * whatever was chosen, so a card headed "My week on Caprock" carried a month's
 * models under it — five of them, against the one that actually ran that week,
 * and $5,473 of Opus against $1,936. The heading named one stretch and the
 * chart drew another.
 */
export async function collectCardData(period: SharePeriod = 'all'): Promise<CardData> {
  const [today, week, month, hist] = await Promise.all([
    api.summary('today'),
    api.summary('7d'),
    api.summary('30d'),
    api.history('all'),
  ])
  // The chosen period's own summary. 'all' has no summary range of its own —
  // history carries the totals but not the per-model split — so it borrows the
  // month, which is the longest split there is, and says so on the card.
  const chosen = period === 'today' ? today : period === '7d' ? week : month
  const toks = (s: { tokens_in: number; tokens_out: number; cache_read: number; cache_write: number }) =>
    s.tokens_in + s.tokens_out + s.cache_read + s.cache_write
  return {
    period,
    takenAt: new Date(),
    today: { cost: today.cost_usd, sessions: today.sessions },
    week: { cost: week.cost_usd, sessions: week.sessions },
    month: { cost: month.cost_usd, tokens: toks(month) },
    allTime: {
      cost: hist.totals.cost_usd,
      days: hist.totals.days,
      tokens: toks(hist.summary),
    },
    cacheHitPct: (chosen.savings?.hit_rate ?? 0) * 100,
    models: (chosen.models ?? []).slice(0, 5)
      .map((m) => ({ label: shortModel(m.model), cost: m.cost_usd })),
    work: (chosen.work ?? []).slice(0, 5)
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
