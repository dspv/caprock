/**
 * The phone home screen's decisions, kept out of the component so they can be
 * tested without a DOM (components/PhoneHome.tsx; .ai/04-ui.md § The phone
 * home).
 */
import type { InboxItem, LimitsAnswer, RateWindow, SessionSummary } from './api'
import { quotePath } from './xtermInput'

/** How many sessions Continue lists. */
export const CONTINUE_MAX = 5
/** A session quiet for longer than this is history, not something to continue. */
export const CONTINUE_WINDOW_MS = 2 * 24 * 60 * 60 * 1000

function at(s: SessionSummary): number {
  return Math.max(s.worked_at || 0, s.last_event_at || 0)
}

function rank(s: SessionSummary): number {
  const h = s.activity?.health
  if (h === 'waiting-on-you') return 0
  if (h === 'working' || h === 'looping' || h === 'error') return 1
  if (s.status !== 'ended') return 2
  return 3
}

/**
 * The sessions worth one tap: waiting on you first, then working, then the
 * rest of what is open, then what ended lately — newest first within each,
 * the last two days only, at most CONTINUE_MAX.
 */
export function continueList(sessions: readonly SessionSummary[], now: number, max = CONTINUE_MAX): SessionSummary[] {
  return sessions
    .filter((s) => rank(s) < 2 || now - at(s) < CONTINUE_WINDOW_MS)
    .slice()
    .sort((a, b) => rank(a) - rank(b) || at(b) - at(a))
    .slice(0, max)
}

/** Sessions a permission prompt or a question holds, that this screen may answer. */
export function waitingOnYou(sessions: readonly SessionSummary[]): SessionSummary[] {
  return sessions.filter((s) => s.activity?.health === 'waiting-on-you' && s.owned && s.status !== 'ended' && !s.detached)
}

/** What another app shared, read off the share target's GET (manifest.json). */
export interface Shared { text: string }

/**
 * The text a Web Share Target put in the query (`/?title=&text=&url=`), joined
 * as a person would write it; null when nothing was shared. Android Chrome
 * sends a link as `text` in some apps and `url` in others, and a title that
 * often repeats the text, so a part already contained in another is dropped.
 */
export function sharedFromSearch(search: string): Shared | null {
  const q = new URLSearchParams(search)
  if (!['title', 'text', 'url'].some((k) => q.has(k))) return null
  const parts: string[] = []
  for (const key of ['title', 'text', 'url']) {
    const v = (q.get(key) ?? '').trim()
    if (v && !parts.some((p) => p.includes(v))) parts.push(v)
  }
  return { text: parts.join('\n') }
}

/** Which sheet a home-screen shortcut asked for: `#/?open=chat` or `#/?open=save`. */
export function openFromHash(hash: string): 'chat' | 'save' | null {
  const q = new URLSearchParams(hash.split('?')[1] ?? '')
  const v = q.get('open')
  return v === 'chat' || v === 'save' ? v : null
}

/** A first message: the words, then each file's path quoted as the paste path is. */
export function messageWith(text: string, paths: readonly string[]): string {
  const files = paths.map(quotePath).join(' ')
  const t = text.trim()
  return [t, files].filter(Boolean).join(t && files ? '\n\n' : '')
}

/** Which way a browser adds a page to the home screen, for the install hint. */
export type InstallWay = 'ios' | 'android' | null

/**
 * Whether to offer the hint, and how: a phone, in its browser rather than the
 * home-screen app, that has not dismissed it. iPadOS reports a Mac, so a
 * touch Mac counts as iOS.
 */
export function installWay(ua: string, standalone: boolean, touchPoints: number): InstallWay {
  if (standalone) return null
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1)) return 'ios'
  if (/Android/.test(ua)) return 'android'
  return null
}

/** Whether this page runs as the home-screen app. */
export function isStandalone(): boolean {
  try {
    if (window.matchMedia?.('(display-mode: standalone)').matches) return true
  } catch { /* an old browser */ }
  return (navigator as Navigator & { standalone?: boolean }).standalone === true
}

export const INSTALL_HINT_KEY = 'caprock.phone.installHint'

/** The sections that fold, and the key their state is kept under on this device. */
export type FoldKey = 'continue' | 'releases' | 'saved'
export const FOLDS_KEY = 'caprock.phone.folds'
/** true = folded. Continue open, Releases and Saved folded (owner, 2026-10-21). */
export const DEFAULT_FOLDS: Readonly<Record<FoldKey, boolean>> = { continue: false, releases: true, saved: true }

/** The folds kept on this device, each falling back to its default; a storage error gives the defaults. */
export function readFolds(): Record<FoldKey, boolean> {
  const out = { ...DEFAULT_FOLDS }
  try {
    const kept = JSON.parse(localStorage.getItem(FOLDS_KEY) ?? '{}') as Record<string, unknown> | null
    for (const k of Object.keys(out) as FoldKey[]) {
      const v = kept?.[k]
      if (typeof v === 'boolean') out[k] = v
    }
  } catch { /* the defaults */ }
  return out
}

export function keepFolds(f: Record<FoldKey, boolean>): void {
  try { localStorage.setItem(FOLDS_KEY, JSON.stringify(f)) } catch { /* this device only; not remembering is fine */ }
}

/** Continue folded: how many of its rows wait on you, work, and sit idle (ended rows are not counted). */
export function continueCounts(rows: readonly SessionSummary[]): { waiting: number; working: number; idle: number } {
  const n = { waiting: 0, working: 0, idle: 0 }
  for (const s of rows) {
    if (s.status === 'ended') continue
    const h = s.activity?.health
    if (h === 'waiting-on-you') n.waiting++
    else if (h === 'working' || h === 'looping') n.working++
    else n.idle++
  }
  return n
}

const SAVED_WORDS = 40

/** Saved folded: how many, the newest, and its words cut short. */
export function savedSummary(items: readonly InboxItem[]): { count: number; newest?: InboxItem; text: string } {
  const newest = items.reduce<InboxItem | undefined>((a, i) => (!a || i.created_at > a.created_at ? i : a), undefined)
  const words = newest ? (newest.text.trim() || `${newest.files.length} photo${newest.files.length === 1 ? '' : 's'}`) : ''
  const text = words.length > SAVED_WORDS ? `${words.slice(0, SAVED_WORDS).trimEnd()}…` : words
  return { count: items.length, newest, text }
}

/** At or past this share of a window or of the context a figure turns amber; at DANGER_PCT, red. */
export const WARN_PCT = 80
export const DANGER_PCT = 95

export type Tone = 'warn' | 'danger' | undefined
export function pctTone(pct: number): Tone {
  return pct >= DANGER_PCT ? 'danger' : pct >= WARN_PCT ? 'warn' : undefined
}

/** One plan window on the Limits line. */
export interface LimitPart { pct: number; tone: Tone; resetIn?: string }
/** The Limits line: whose windows, the 5-hour one and the weekly one. */
export interface LimitsGlance { agent: 'claude' | 'codex'; five?: LimitPart; week?: LimitPart }

/** A reset further ahead than this is a stale sample (components/PlanLimits readWindow's rule). */
const PLAUSIBLE_MS = 8 * 24 * 3600 * 1000

/** "12m", "1h 20m", "3d 4h": how long until a reset, short. */
export function shortIn(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

/**
 * A window as the line says it. One whose reset has passed has rolled over:
 * its figure is the old window's, so it is left out rather than shown as now.
 * A reset implausibly far ahead keeps the figure and loses the clock.
 */
function limitPart(w: RateWindow | undefined, now: number): LimitPart | undefined {
  if (!w) return undefined
  const resetMs = (w.resets_at ?? 0) * 1000
  if (resetMs && resetMs <= now) return undefined
  const pct = Math.round(w.used_percentage)
  const part: LimitPart = { pct, tone: pctTone(pct) }
  if (resetMs > now && resetMs < now + PLAUSIBLE_MS) part.resetIn = shortIn(resetMs - now)
  return part
}

/** The Limits line from `GET /v1/stats/limits`: Claude Code's windows, else Codex's; undefined when neither says anything. */
export function limitsGlance(a: LimitsAnswer | undefined, now: number): LimitsGlance | undefined {
  const pairs = [['claude', a?.rate_limits], ['codex', a?.codex_rate_limits]] as const
  for (const [agent, rl] of pairs) {
    const five = limitPart(rl?.five_hour, now)
    const week = limitPart(rl?.seven_day, now)
    if (five || week) return { agent, five, week }
  }
  return undefined
}

/** What a live Continue row says under its words: the context used and the subagents at work. */
export interface RowMeta { ctx?: number; hot: boolean; subagents: number }
export function rowMeta(s: SessionSummary): RowMeta | undefined {
  if (s.status === 'ended') return undefined
  const ctx = s.context ? Math.round(s.context.pct) : undefined
  const subagents = s.live_subagents ?? 0
  if (ctx === undefined && subagents === 0) return undefined
  return { ctx, hot: ctx !== undefined && ctx >= WARN_PCT, subagents }
}
