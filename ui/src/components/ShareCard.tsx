/**
 * A picture of your own numbers, drawn locally — the Figures card.
 *
 * The figures are the most persuasive thing this product has, and they are
 * stuck inside one machine — this is the only feature here that works as both
 * a thing to use and a thing that travels. Nothing is uploaded: the card is
 * drawn on a canvas in the browser, so what happens to it after that is the
 * user's decision, not ours.
 *
 * Deliberately no project names on it. A share button that quietly publishes
 * which repositories someone works on is a trap, and the figures alone are the
 * interesting part anyway.
 *
 * One figure, said big (owner, 2026-10-10: the eight-tile card was "not
 * noticeable, not attractive", translated). It was drawn to look like the
 * dashboard — eight tiles and two bar charts — on the theory that a real
 * screen gets looked at. In a feed it read as a spreadsheet: at the size a
 * card is seen, sixteen numbers are none. A card someone wants to post tells
 * one story at a glance: the figure for the period, what it is (API list
 * prices, never a bill), two or three facts that make it believable, which
 * agents did the work, and where to get your own.
 */
import { api, type WeekAgent } from '@/lib/api'
import { agentMarkPath } from './AgentMarks'
import { agentName } from './Characters'

const W = 1200
const H = 630

/** Which stretch a card is about.
 *
 * The period decides what is said big. A card that answers four questions
 * answers none of them loudly, and someone sharing a working week does not
 * want their lifetime total to be the headline. */
export type SharePeriod = 'today' | '7d' | '30d' | 'all'

/** What each period is called on the card and in the dialog. */
export const PERIOD_LABEL: Record<SharePeriod, string> = {
  today: 'today',
  '7d': 'this week',
  '30d': 'this month',
  all: 'all time',
}

/**
 * The two grounds a card is drawn on. Dark is the product's graphite; paper is
 * caprock.dev's cream, ink and amber, so a card on the light theme looks like
 * the site it points at. Fixed values rather than the screen's tokens: a card
 * is a picture that leaves the machine, and it must look the same whichever
 * tone the dashboard happened to be in.
 */
export type CardLook = 'dark' | 'paper'

interface Palette {
  bg: string
  raise: string
  line: string
  ink: string
  muted: string
  faint: string
  accent: string
  /** The glow behind the figure, and the brand mark's fill. */
  glow: string
}

const PALETTE: Record<CardLook, Palette> = {
  dark: { bg: '#1b1b1a', raise: '#262422', line: '#3a3835', ink: '#ece9e4', muted: '#a9a59e', faint: '#837f78', accent: '#feb157', glow: '#feb157' },
  paper: { bg: '#efe7d6', raise: '#f4ecdd', line: '#c2b293', ink: '#2b251c', muted: '#4f473b', faint: '#665d4f', accent: '#8a4f0c', glow: '#eb9a3e' },
}

/** The look that matches the screen: paper on a light theme, graphite otherwise. */
export function screenLook(): CardLook {
  try {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'paper' : 'dark'
  } catch {
    return 'dark'
  }
}

/** One agent's part of the period's work. */
export interface CardAgent { agent: string; cost: number; turns: number }

/** The plan the user said they are on (Settings), when they said. */
export interface CardPlan { kind: 'flat' | 'metered'; label: string; usdPerMonth: number }

/** Everything a card shows. Gathered by the caller, drawn here. */
export interface CardData {
  /** Which stretch this card is about. */
  period: SharePeriod
  /** When the card was drawn. A figure in a feed weeks later needs a date. */
  takenAt: Date
  /** The period's figures. */
  cost: number
  sessions: number
  tokens: number
  cacheHitPct: number
  /** Days with any activity; all time only. */
  activeDays?: number
  /** Who did the work, most expensive first, subagents folded into their agent. */
  agents: CardAgent[]
  plan?: CardPlan
}

/** The steps the dialog ticks off while the figures arrive. */
export type CardStep = 'totals' | 'agents' | 'plan'

export const STEP_LABEL: Record<CardStep, string> = {
  totals: 'Reading the totals',
  agents: 'Reading which agents did the work',
  plan: 'Reading your plan',
}

/** Agent colours on the card: brand where there is one, ink where the brand is black or white. */
const AGENT_HUE: Record<string, string> = {
  claude: '#d97757',
  gemini: '#8e75b2',
  deepseek: '#5786fe',
}

function mix(a: string, b: string, t: number): string {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
  const x = p(a)
  const y = p(b)
  return `#${x.map((v, i) => Math.round(v * t + y[i]! * (1 - t)).toString(16).padStart(2, '0')).join('')}`
}

/** An agent's colour on a ground: the brand mixed 75/25 with the muted ink, as the app's marks are. */
export function agentColour(agent: string, look: CardLook): string {
  const p = PALETTE[look]
  const hue = AGENT_HUE[agent]
  if (hue) return mix(hue, p.muted, 0.75)
  return agent === 'codex' ? p.ink : p.muted
}

/** Dollars as the card says them: whole above $100, cents below. */
export function cardMoney(v: number): string {
  if (!(v > 0)) return '$0'
  if (v >= 100) return `$${Math.round(v).toLocaleString('en-US')}`
  return `$${v.toFixed(2)}`
}

function shortTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${Math.round(n / 1e6)}M`
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`
  return String(Math.round(n))
}

/** How many days a period's plan fee covers, for the multiple. */
const PLAN_DAYS: Partial<Record<SharePeriod, number>> = { '7d': 7, '30d': 30 }

/** The one figure the card is about, the words that say what it is, and a smaller line under them. */
export interface Hero { figure: string; line: string; sub: string }

/**
 * Who did the work, in the card's words: one or two agents by name, more as
 * one phrase. Every agent with a share the legend shows is named — a card
 * that says "of Claude Code" over a bar with Codex in it says two things.
 */
function whoWorked(d: CardData): string {
  const names = mixOf(d).filter((m) => m.agent !== 'other').map((m) => m.name)
  if (names.length === 0) return 'Claude Code'
  if (names.length === 1) return names[0]!
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return 'AI coding agents'
}

/**
 * What is said big.
 *
 * On a flat plan, over a week or a month, the multiple: "29× my $200/mo Max
 * plan". It is the number people actually wonder about, and it is honest only
 * there — a day's share of a monthly fee is not a thing anyone pays, and the
 * lifetime of a subscription is not something Caprock knows. Everywhere else,
 * the dollars at API list prices. Never "saved": without the plan the work
 * would not have been run at this volume (PlanValue says the same).
 */
export function heroOf(d: CardData): Hero {
  const who = whoWorked(d)
  const when = d.period === 'all' ? ', all time' : ` ${PERIOD_LABEL[d.period]}`
  const days = PLAN_DAYS[d.period]
  const plan = d.plan
  if (plan && plan.kind === 'flat' && plan.usdPerMonth > 0 && days) {
    const fee = (plan.usdPerMonth * days) / 30
    const multiple = d.cost / fee
    if (multiple >= 1.5) {
      const m = multiple >= 10 ? Math.round(multiple).toString() : multiple.toFixed(1).replace(/\.0$/, '')
      const name = plan.label ? `${plan.label} plan` : 'plan'
      return {
        figure: `${m}×`,
        line: `my ${cardMoney(plan.usdPerMonth)}/mo ${name}`,
        sub: `${cardMoney(d.cost)} of ${who}${when} at API list prices — not a bill`,
      }
    }
  }
  return {
    figure: cardMoney(d.cost),
    line: `of ${who}${when}`,
    sub: 'at API list prices — not a bill',
  }
}

/** The supporting facts: at most three, each one that was measured. */
export function factsOf(d: CardData): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = []
  out.push({ value: d.sessions.toLocaleString('en-US'), label: d.sessions === 1 ? 'session' : 'sessions' })
  if (d.tokens > 0) out.push({ value: shortTokens(d.tokens), label: 'tokens' })
  if (d.cacheHitPct > 0) out.push({ value: `${Math.round(d.cacheHitPct)}%`, label: 'cache hit' })
  return out.slice(0, 3)
}

/** The agent mix: top four by cost, the rest as one, each with its share. */
export function mixOf(d: CardData): { agent: string; name: string; pct: number }[] {
  const total = d.agents.reduce((a, x) => a + x.cost, 0)
  const byTurns = total <= 0
  const sum = byTurns ? d.agents.reduce((a, x) => a + x.turns, 0) : total
  if (sum <= 0) return []
  const rows = d.agents
    .map((a) => ({ agent: a.agent, name: agentName(a.agent), v: byTurns ? a.turns : a.cost }))
    .filter((a) => a.v > 0)
  const top = rows.slice(0, 4)
  const rest = rows.slice(4).reduce((a, x) => a + x.v, 0)
  if (rest > 0) top.push({ agent: 'other', name: 'other', v: rest })
  return top.map((r) => ({ agent: r.agent, name: r.name, pct: Math.max(1, Math.round((100 * r.v) / sum)) }))
}

/** The date line: the stretch, in words a stranger can read. */
export function rangeWords(d: CardData): string {
  // Months spelled here: en-GB's short month is "Sept" in current ICU and
  // "Sep" in older ones, and a card should not depend on which.
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const fmt = (x: Date, year: boolean) => `${x.getDate()} ${MONTHS[x.getMonth()]}${year ? ` ${x.getFullYear()}` : ''}`
  const end = d.takenAt
  if (d.period === 'today') return fmt(end, true)
  if (d.period === 'all') return d.activeDays ? `${d.activeDays} active ${d.activeDays === 1 ? 'day' : 'days'}` : 'all time'
  const start = new Date(end)
  start.setDate(end.getDate() - (d.period === '7d' ? 6 : 29))
  return `${fmt(start, start.getFullYear() !== end.getFullYear())} – ${fmt(end, true)}`
}

const SANS = '"Hanken Grotesk Variable", "Hanken Grotesk", ui-sans-serif, system-ui, sans-serif'
const MONO = '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, monospace'

/** The bundled faces, loaded before a draw: a canvas does not wait for them and falls back silently. */
async function fontsReady(): Promise<void> {
  try {
    const f = document.fonts
    if (!f?.load) return
    await Promise.all([
      f.load(`800 160px ${SANS}`), f.load(`600 32px ${SANS}`), f.load(`500 20px ${SANS}`),
      f.load(`700 40px ${MONO}`), f.load(`500 16px ${MONO}`),
    ])
  } catch { /* draw with what there is */ }
}

function paintCard(g: CanvasRenderingContext2D, d: CardData, look: CardLook) {
  const p = PALETTE[look]
  const pad = 64

  g.fillStyle = p.bg
  g.fillRect(0, 0, W, H)

  // A warm light from the top right, where the brand's triangle sits: the
  // card has to be noticed in a feed of photographs before it is read.
  const glow = typeof g.createRadialGradient === 'function' ? g.createRadialGradient(W - 140, 40, 10, W - 140, 40, 760) : undefined
  if (glow) {
    glow.addColorStop(0, `${p.glow}${look === 'dark' ? '2e' : '3d'}`)
    glow.addColorStop(1, `${p.glow}00`)
    g.fillStyle = glow
    g.fillRect(0, 0, W, H)
  }

  const text = (x: number, y: number, s: string, font: string, fill: string, align: CanvasTextAlign = 'left') => {
    g.font = font
    g.fillStyle = fill
    g.textAlign = align
    g.fillText(s, x, y)
  }
  const width = (s: string, font: string) => { g.font = font; return g.measureText(s).width }

  // The brand's triangle, large and faint behind the figure: the card is
  // recognisably ours from across a feed without the logo shouting.
  g.save?.()
  g.globalAlpha = look === 'dark' ? 0.07 : 0.1
  g.strokeStyle = p.accent
  g.lineWidth = 26
  g.lineJoin = 'round'
  g.beginPath()
  g.moveTo(W - 250, 120)
  g.lineTo(W - 60, 450)
  g.lineTo(W - 440, 450)
  g.closePath()
  g.stroke()
  g.globalAlpha = 1
  g.restore?.()

  // Top: the brand on the left, the stretch on the right.
  g.strokeStyle = p.accent
  g.lineWidth = 3.4
  g.lineJoin = 'round'
  g.beginPath()
  g.moveTo(pad + 15, 50)
  g.lineTo(pad + 30, 76)
  g.lineTo(pad, 76)
  g.closePath()
  g.stroke()
  const brandFont = `700 27px ${MONO}`
  text(pad + 44, 74, 'cap', brandFont, p.ink)
  text(pad + 44 + width('cap', brandFont), 74, 'rock', brandFont, p.accent)
  const period = d.period === 'all' ? 'ALL TIME' : PERIOD_LABEL[d.period].toUpperCase()
  const range = rangeWords(d).toUpperCase()
  const rangeFont = `500 17px ${MONO}`
  text(W - pad, 72, range, rangeFont, p.faint, 'right')
  const rw = width(range, rangeFont)
  text(W - pad - rw - 14, 72, '·', rangeFont, p.faint, 'right')
  text(W - pad - rw - 34, 72, period, `700 17px ${MONO}`, p.accent, 'right')

  // The figure. Fitted to the width it has, never clipped: a five-figure
  // all-time total is wider than a week's.
  const hero = heroOf(d)
  let size = 176
  const maxW = W - pad * 2 - 40
  while (size > 96 && width(hero.figure, `800 ${size}px ${SANS}`) > maxW) size -= 6
  const heroY = 120 + size * 0.86
  text(pad - 4, heroY, hero.figure, `800 ${size}px ${SANS}`, p.accent)
  // What the figure is, in a sentence that starts where the figure ends.
  // Its line sits clear of the figure's descenders (the comma in "$1,290").
  let lineSize = 40
  while (lineSize > 28 && width(hero.line, `600 ${lineSize}px ${SANS}`) > W - pad * 2) lineSize -= 2
  text(pad, heroY + 68, hero.line, `600 ${lineSize}px ${SANS}`, p.ink)
  text(pad, heroY + 106, hero.sub, `500 22px ${SANS}`, p.muted)

  // The facts, under a hairline, on the left.
  const rowY = 470
  g.fillStyle = p.line
  g.fillRect(pad, rowY - 4, W - pad * 2, 1)
  const facts = factsOf(d)
  let x = pad
  for (const f of facts) {
    const vf = `700 38px ${MONO}`
    text(x, rowY + 50, f.value, vf, p.ink)
    text(x, rowY + 80, f.label, `500 17px ${SANS}`, p.muted)
    x += Math.max(width(f.value, vf), width(f.label, `500 17px ${SANS}`)) + 54
  }

  // The agents, on the right: a bar of their shares and a mark for each.
  const mix = mixOf(d)
  if (mix.length > 0) {
    const left = Math.max(x + 10, 620)
    const barW = W - pad - left
    const barY = rowY + 26
    let bx = left
    mix.forEach((m, i) => {
      const w = i === mix.length - 1 ? left + barW - bx : Math.max(3, (barW * m.pct) / 100)
      g.fillStyle = m.agent === 'other' ? p.line : agentColour(m.agent, look)
      g.fillRect(bx, barY, Math.max(0, w - (i === mix.length - 1 ? 0 : 3)), 8)
      bx += w
    })
    // The legend: mark, name, share. Fewer names when they do not fit.
    let lx = left
    const ly = barY + 48
    for (const m of mix) {
      const label = `${m.name} ${m.pct}%`
      const lw = 26 + width(label, `600 17px ${SANS}`)
      if (lx + lw > W - pad + 2) break
      drawMark(g, m.agent, lx, ly - 16, 19, m.agent === 'other' ? p.faint : agentColour(m.agent, look))
      text(lx + 26, ly, m.name, `600 17px ${SANS}`, p.ink)
      text(lx + 26 + width(`${m.name} `, `600 17px ${SANS}`), ly, `${m.pct}%`, `500 17px ${MONO}`, p.muted)
      lx += lw + 22
    }
  }

  // The foot: how it was measured on the left; the invitation opposite. A
  // question, not a command — "What's yours?" is the thing a reader wonders
  // at a figure like this, and the domain is where they find out. The caveat
  // is under the figure itself: a dollar figure posted without it reads as a
  // bill somebody paid.
  const footY = H - 40
  text(pad, footY, 'measured locally · totals only, no names', `500 15px ${MONO}`, p.faint)
  const domain = 'caprock.dev'
  const df = `700 20px ${MONO}`
  text(W - pad, footY, domain, df, p.accent, 'right')
  text(W - pad - width(domain, df) - 14, footY, "What's yours?", `600 20px ${SANS}`, p.ink, 'right')
  g.textAlign = 'left'
}

/** An agent's mark at (x, y), `s` pixels square. */
function drawMark(g: CanvasRenderingContext2D, agent: string, x: number, y: number, s: number, colour: string) {
  const path = agentMarkPath(agent)
  g.save?.()
  g.translate?.(x, y)
  g.scale?.(s / 24, s / 24)
  g.fillStyle = colour
  g.strokeStyle = colour
  if (path && typeof Path2D !== 'undefined') {
    g.fill(new Path2D(path))
  } else if (agent === 'codex') {
    g.lineWidth = 2.2
    g.beginPath()
    g.moveTo(7.5, 2.5)
    g.arcTo(21.5, 2.5, 21.5, 21.5, 5)
    g.arcTo(21.5, 21.5, 2.5, 21.5, 5)
    g.arcTo(2.5, 21.5, 2.5, 2.5, 5)
    g.arcTo(2.5, 2.5, 21.5, 2.5, 5)
    g.closePath()
    g.stroke()
    g.beginPath()
    // The "C": the long way round from upper right to lower right.
    g.arc?.(12, 12, 4.2, -0.736, 0.736, true)
    g.stroke()
  } else {
    g.beginPath()
    g.arc?.(12, 12, 5, 0, Math.PI * 2)
    g.fill()
  }
  g.restore?.()
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

/** Subagents folded into the agent that ran them, most expensive first. */
export function foldAgents(rows: WeekAgent[]): CardAgent[] {
  const by = new Map<string, CardAgent>()
  for (const r of rows) {
    const cur = by.get(r.agent) ?? { agent: r.agent, cost: 0, turns: 0 }
    cur.cost += r.cost_usd
    cur.turns += r.turns
    by.set(r.agent, cur)
  }
  return [...by.values()].sort((a, b) => b.cost - a.cost || b.turns - a.turns)
}

/**
 * Gather what the card needs: the period's totals, its agents, and the plan.
 *
 * Only the period asked for. The old card read four ranges to light one tile
 * of eight; a card that says one thing needs one range. The agents and the
 * plan are extras — a card without them is still a card, so either failing
 * leaves it out rather than failing the draw.
 */
export async function collectCardData(period: SharePeriod = '7d', onStep?: (step: CardStep) => void): Promise<CardData> {
  const step = <T,>(p: Promise<T>, k: CardStep) => p.then((v) => { onStep?.(k); return v })
  const toks = (s: { tokens_in: number; tokens_out: number; cache_read: number; cache_write: number }) =>
    s.tokens_in + s.tokens_out + s.cache_read + s.cache_write
  const totals = step((async () => {
    if (period === 'all') {
      const h = await api.history('all')
      return {
        cost: h.totals.cost_usd, sessions: h.totals.sessions, tokens: toks(h.summary),
        hit: h.savings?.hit_rate ?? h.summary?.savings?.hit_rate ?? 0, days: h.totals.days,
      }
    }
    const s = await api.summary(period)
    return { cost: s.cost_usd, sessions: s.sessions, tokens: toks(s), hit: s.savings?.hit_rate ?? 0, days: undefined }
  })(), 'totals')
  const agents = step(api.glance(period).then((g) => foldAgents(g.agents ?? [])).catch(() => [] as CardAgent[]), 'agents')
  const plan = step(api.settings().then((s): CardPlan | undefined => (
    s.plan_kind === 'flat' || s.plan_kind === 'metered'
      ? { kind: s.plan_kind, label: s.plan_label ?? '', usdPerMonth: s.plan_usd_per_month ?? 0 }
      : undefined
  )).catch(() => undefined), 'plan')
  const [t, a, pl] = await Promise.all([totals, agents, plan])
  return {
    period,
    takenAt: new Date(),
    cost: t.cost,
    sessions: t.sessions,
    tokens: t.tokens,
    cacheHitPct: t.hit * 100,
    activeDays: t.days,
    agents: a,
    plan: pl,
  }
}

/**
 * Draw the card and hand back a PNG, with no component around it.
 *
 * Returns null when the browser cannot draw (jsdom, and any headless context
 * without a canvas). Callers say so rather than failing silently.
 */
export async function drawShareCard(data: CardData, look: CardLook = screenLook()): Promise<Blob | null> {
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
  await fontsReady()
  // Painting is inside the guard too: one unexpected figure in a real dataset
  // must report a card that could not be drawn, not hang the dialog on
  // "drawing…".
  try {
    paintCard(g, data, look)
  } catch {
    return null
  }
  return await new Promise<Blob | null>((resolve) => {
    if (typeof c.toBlob !== 'function') { resolve(null); return }
    c.toBlob((b) => resolve(b), 'image/png')
  })
}
