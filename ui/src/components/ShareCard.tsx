/**
 * What every share card has in common: the periods, the two grounds a card is
 * drawn on, the brand and the faces, and the file's name.
 *
 * The dashboard's card is the Week card (WeekCard.tsx), drawn as a page and
 * captured; the Pipeline's is painted on a canvas (PipelineShareCard.ts) and
 * borrows the palette, the faces and the brand from here. Until 2026-10-25
 * this file also painted a second dashboard card, "Figures", led by the
 * plan's multiple while the Week card led with PRs — so the format changed
 * the message, and the owner would not share either (.ai/04-ui.md § Sharing
 * figures).
 *
 * Deliberately no project names on any card. A share button that quietly
 * publishes which repositories someone works on is a trap.
 */

/** Which stretch a card is about. */
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

export interface Palette {
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

export const PALETTE: Record<CardLook, Palette> = {
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

/** Agent colours on a card: brand where there is one, ink where the brand is black or white. */
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

/**
 * An agent's mark colour on a ground: its bar colour, except OpenAI's Blossom,
 * which OpenAI allows in black or white only (OpenAIBlossom.ts).
 */
export function markColour(agent: string, look: CardLook): string {
  if (agent === 'chatgpt') return look === 'dark' ? '#ffffff' : '#000000'
  return agentColour(agent, look)
}

export const SANS = '"Hanken Grotesk Variable", "Hanken Grotesk", ui-sans-serif, system-ui, sans-serif'
export const MONO = '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, monospace'

/** The bundled faces, loaded before a draw: a canvas does not wait for them and falls back silently. */
export async function fontsReady(): Promise<void> {
  try {
    const f = document.fonts
    if (!f?.load) return
    await Promise.all([
      f.load(`800 160px ${SANS}`), f.load(`600 32px ${SANS}`), f.load(`500 20px ${SANS}`),
      f.load(`700 40px ${MONO}`), f.load(`500 16px ${MONO}`),
    ])
  } catch { /* draw with what there is */ }
}

/** The brand — the triangle and "caprock" — with its baseline at y. */
export function drawBrand(g: CanvasRenderingContext2D, x: number, y: number, look: CardLook) {
  const p = PALETTE[look]
  g.strokeStyle = p.accent
  g.lineWidth = 3.4
  g.lineJoin = 'round'
  g.beginPath()
  g.moveTo(x + 15, y - 24)
  g.lineTo(x + 30, y + 2)
  g.lineTo(x, y + 2)
  g.closePath()
  g.stroke()
  const f = `700 27px ${MONO}`
  g.font = f
  g.textAlign = 'left'
  g.fillStyle = p.ink
  g.fillText('cap', x + 44, y)
  const w = g.measureText('cap').width
  g.fillStyle = p.accent
  g.fillText('rock', x + 44 + w, y)
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
