/**
 * Continue on another provider at a usage limit (ADR-090): what the limit
 * strip under a terminal says and offers, what Settings → When a limit is
 * reached lists, and the one path every move takes to the workspace — the
 * tab follows the new session and a toast says where it went, with Undo.
 *
 * A move arrives twice for a click (the POST's answer and the `continued`
 * live frame) and once for Caprock's own (the frame): `announceContinued`
 * passes each on once.
 */
import type { ContinueOnResult, LimitHit, Session, Subscription, SubscriptionsResponse } from './api'
import type { Character } from '@/components/Characters'
import type { Face } from './faces'
import { resetText } from './subscriptions'

/** "5-hour limit", "Weekly limit", or "Usage limit" for a window Claude Code names otherwise. */
export function limitName(window?: string): string {
  if (window === 'five_hour') return '5-hour limit'
  if (window?.startsWith('seven_day')) return 'Weekly limit'
  return 'Usage limit'
}

/** "2h 14m", "14m", "3d 4h": how long until `at`. */
export function untilText(at: number, now = Date.now()): string {
  const min = Math.max(1, Math.round((at - now) / 60_000))
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h ${min % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

/** The strip's first words: the limit, and when it reopens if the plan said and it is still ahead. */
export function limitLine(hit: LimitHit, now = Date.now()): { name: string; back?: string; until?: string } {
  const name = limitName(hit.window)
  if (!hit.resets_at || hit.resets_at <= now) return { name }
  return { name, back: resetText(hit.resets_at / 1000, new Date(now)), until: untilText(hit.resets_at, now) }
}

/** One place a session can go on. */
export interface ContinueChoice {
  target: string
  label: string
  /** The character on its chip. */
  who: Character
  face?: Face
  /** Codex: a new session from a summary, not the same conversation. */
  summary: boolean
}

/** What a chip's tooltip says, honestly. */
export function choiceTitle(c: ContinueChoice): string {
  return c.summary ? 'New Codex session, starts from a summary' : 'Same session, full context'
}

/** A session the strip is for: a Claude Code session Caprock started, still open, stopped at its limit. */
export function atLimit(s: Pick<Session, 'limit_hit' | 'owned' | 'status' | 'agent' | 'kind'> | undefined): boolean {
  return !!s?.limit_hit && s.owned && s.status !== 'ended' && s.kind !== 'shell' && (!s.agent || s.agent === 'claude')
}

/** The id a session's own subscription goes by in continue-on's terms. */
export function ownTarget(s: Pick<Session, 'subscription'>): string {
  return s.subscription || 'default'
}

/**
 * Where a session can go on now, in the strip's order: other Claude Code
 * sign-ins, DeepSeek and Kimi (listed only while their keys are set), then
 * Codex when it is installed and signed in. Never the one it is on.
 */
export function continueChoices(current: string, subs: SubscriptionsResponse | undefined): ContinueChoice[] {
  if (!subs) return []
  const out: ContinueChoice[] = []
  const claude = subs.agents.find((g) => g.agent === 'claude')
  const usable = (s: Subscription) => s.id !== current && s.signed_in
  for (const s of claude?.subscriptions ?? []) {
    if (!usable(s) || s.provider) continue
    out.push({ target: s.id, label: `Claude · ${s.label}`, who: 'lead', face: 'cap', summary: false })
  }
  for (const p of ['deepseek', 'kimi'] as const) {
    const s = claude?.subscriptions.find((x) => x.provider === p || x.id === p)
    if (s && usable(s)) out.push(p === 'deepseek'
      ? { target: 'deepseek', label: 'DeepSeek', who: 'deepseek', summary: false }
      : { target: 'kimi', label: 'Kimi', who: 'lead', face: 'wizard', summary: false })
  }
  const codex = subs.agents.find((g) => g.agent === 'codex')
  if (codex?.installed) {
    // Own ids are per agent ('default' is Claude's and Codex's both): a
    // Claude Code session is never on a Codex sign-in, so none is skipped.
    const signed = codex.subscriptions.filter((s) => s.signed_in)
    for (const s of signed) {
      out.push({ target: s.default ? 'codex' : s.id, label: signed.length > 1 ? `Codex · ${s.label}` : 'Codex', who: 'codex', summary: true })
    }
  }
  return out
}

/** Every target Settings can order: the available ones and the saved ones, saved order first. */
export function fallbackRows(saved: readonly string[], available: readonly ContinueChoice[]): { target: string; choice?: ContinueChoice }[] {
  const byTarget = new Map(available.map((c) => [c.target, c]))
  const rows = saved.map((t) => ({ target: t, choice: byTarget.get(t) }))
  for (const c of available) if (!saved.includes(c.target)) rows.push({ target: c.target, choice: c })
  return rows
}

/** A target's name in a sentence: "Kimi", "Claude · Work", "Claude" for the own sign-in. */
export function targetName(target: string, subs?: SubscriptionsResponse): string {
  if (target === 'deepseek') return 'DeepSeek'
  if (target === 'kimi') return 'Kimi'
  if (target === 'codex') return 'Codex'
  if (target === 'default') return 'Claude'
  for (const g of subs?.agents ?? []) {
    const s = g.subscriptions.find((x) => x.id === target)
    if (s) return `${g.agent === 'codex' ? 'Codex' : 'Claude'} · ${s.label}`
  }
  return 'another sign-in'
}

/** The toast's sentence, without its Undo: "Moved to Kimi · same session · back to Claude at 18:40". */
export function movedText(r: ContinueOnResult, subs?: SubscriptionsResponse, now = Date.now()): string {
  const parts = [`Moved to ${targetName(r.target, subs)}`, r.same_conversation ? 'same session' : 'new session from a summary']
  if (r.return_at && r.return_at > now) parts.push(`back to ${targetName(r.from, subs)} at ${resetText(r.return_at / 1000, new Date(now))}`)
  return parts.join(' · ')
}

// "Wait": the strip hides for this limit of this session, in this window.
const waited = new Set<string>()
const waitKey = (id: string, hit: LimitHit) => `${id}:${hit.at}`
export function waitedOut(id: string, hit: LimitHit): boolean { return waited.has(waitKey(id, hit)) }
export function waitOut(id: string, hit: LimitHit): void { waited.add(waitKey(id, hit)) }

// Moves, passed on once each.
type Listener = (r: ContinueOnResult) => void
const listeners = new Set<Listener>()
const moves = new Map<string, ContinueOnResult>()
const waiters = new Map<string, Set<(r: ContinueOnResult) => void>>()

/** A session moved: tell the workspace, once per move. */
export function announceContinued(r: ContinueOnResult): void {
  const prev = moves.get(r.continued_from)
  if (prev && prev.session_id === r.session_id) return
  moves.set(r.continued_from, r)
  for (const fn of waiters.get(r.continued_from) ?? []) fn(r)
  waiters.delete(r.continued_from)
  for (const fn of listeners) fn(r)
}

export function onContinued(fn: Listener): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/**
 * The move that took `id` away, waiting up to `ms` for one: the original's
 * process is ended once the new one has started, so its terminal can report
 * the exit before the move arrives — and must not become a shell meanwhile.
 */
export function movedAway(id: string, ms: number): Promise<ContinueOnResult | null> {
  const done = moves.get(id)
  if (done) return Promise.resolve(done)
  return new Promise((resolve) => {
    const set = waiters.get(id) ?? new Set()
    const fn = (r: ContinueOnResult) => { clearTimeout(t); resolve(r) }
    const t = setTimeout(() => { set.delete(fn); resolve(null) }, ms)
    set.add(fn)
    waiters.set(id, set)
  })
}

/** Tests: forget every move and wait. */
export function resetContinued(): void {
  moves.clear()
  waiters.clear()
  waited.clear()
}
